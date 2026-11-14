#!/usr/bin/env node
/* ZCODE_DEBUG_MODE 验证 harness（spec：apps/zcode-cli/docs/design/v2/debug-mode.md 的 Task 3）。

   同一会话内连续 N 次 agent 调用（submitPrompt），逐调用记录结局与全部
   限流信号，显式报告「限额触发后的成功率」（success-rate-after-limit）：
   - success     ：本轮零限流信号，正常拿到回答；
   - retry       ：本轮触发过限流（429/配额码），患者探测后**仍拿到回答**；
   - quota-stop  ：限流持续到 harness 每调用超时（或 turn 终止于限流类错误），
                   本轮没有回答——debug 模式没能救回的那部分；
   - error       ：非限流类失败（auth / invalid / 空回答等），单独列出不并入限流统计。

   判定口径：firstLimitCall 之后（含）的调用里 (success + retry) 占比
   = success-rate-after-limit。>0 且有 retry 复原 ⇒ 软性滚动执行；
   恒 0（全是 quota-stop）⇒ 硬性服务端墙；全程没有限流 ⇒ no-limit（数据无效）。

   关键机制：走产品同一条装配（createZCodeApp，进程内 headless 会话），
   MCP/subagents/title/dynamic-workflow/memory 全关，工具目录关——
   每轮就是一次最小模型调用，限流行为由 adapters runner（患者探测）主导。

   运行（OpenRouter 免费档为例）：
     source ~/.secrets/api-keys.env   # 或自行 export OPENROUTER_API_KEY
     ZCODE_DEBUG_MODE=1 ../../node_modules/.bin/tsx src/run.ts \
       --calls=30 --model="cohere/north-mini-code:free"

   常用参数：--calls=N（默认 30） --model=ID --timeout-ms=每调用超时（默认 240000）
   --debug-mode=0|1（默认 1） --out-dir=DIR（默认 ./runs/<时间戳>）
   --key-env=VARNAME（API key 的 env 名，默认依次取 DEBUG_HARNESS_API_KEY →
   ZCODE_DESKTOP_OPENROUTER_FREE_KEY → OPENROUTER_API_KEY）。

   分片执行（沙箱里 bash 调用有时限、进程不能常驻）：--max-wall-ms=M 到点后
   做完当前调用就收尾写报告；--resume 复用 out-dir 里已有的 ledger.jsonl，
   跳过已记录的调用号续跑——多片拼接后报告覆盖全部调用。 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createZCodeApp } from "@zcode/bootstrap";
import { WORKFLOW_QUOTA_PROVIDER_CODES } from "@zcode/adapters/model";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
  type RegistryModelConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import type { SessionEvent } from "@zcode/contracts";

const PROVIDER_ID = "openrouter-harness";
const DEFAULT_MODEL = "cohere/north-mini-code:free";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** 与 runner/治理器同一张配额码表（workflow 策略表）；reason=rate_limited 另算。 */
const QUOTA_CODES: ReadonlySet<string> = WORKFLOW_QUOTA_PROVIDER_CODES;

interface Argv {
  calls: number;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  debugMode: boolean;
  outDir: string;
  apiKey: string;
  /** 0 = 不限；>0 到点后做完当前调用即收尾（分片执行）。 */
  maxWallMs: number;
  /** 复用 out-dir 的 ledger.jsonl 续跑（跳过已记录调用号）。 */
  resume: boolean;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    if (hit !== undefined) return hit.slice(prefix.length);
    // 裸旗标（--resume 不带值）视为 "1"。
    return args.includes(`--${name}`) ? "1" : undefined;
  };
  const keyEnv =
    flag("key-env") ??
    (process.env.DEBUG_HARNESS_API_KEY
      ? "DEBUG_HARNESS_API_KEY"
      : process.env.ZCODE_DESKTOP_OPENROUTER_FREE_KEY
        ? "ZCODE_DESKTOP_OPENROUTER_FREE_KEY"
        : "OPENROUTER_API_KEY");
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`API key 缺失：export ${keyEnv}=...（或用 --key-env 指定）`);
  return {
    calls: Number(flag("calls") ?? 30),
    model: flag("model") ?? DEFAULT_MODEL,
    baseUrl: flag("provider-base-url") ?? DEFAULT_BASE_URL,
    timeoutMs: Number(flag("timeout-ms") ?? 240_000),
    debugMode: (flag("debug-mode") ?? "1") !== "0",
    outDir: flag("out-dir") ?? `runs/${new Date().toISOString().replaceAll(":", "-")}`,
    apiKey,
    maxWallMs: Number(flag("max-wall-ms") ?? 0),
    resume: (flag("resume") ?? "0") !== "0",
  };
}

interface RetrySignal {
  delayMs: number;
  nextAttempt: number;
  reason: string;
  providerErrorCode?: string;
  statusCode?: number;
}

interface FailureSignal {
  reason: string;
  retryable: boolean;
  providerErrorCode?: string;
  statusCode?: number;
  message: string;
}

interface CallRecord {
  call: number;
  prompt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: "success" | "retry" | "quota-stop" | "error";
  response?: string;
  firstTextMs?: number;
  retries: RetrySignal[];
  failures: FailureSignal[];
  turnError?: { code?: string; message: string };
  aborted?: "per-call-timeout" | "global-abort";
  limitHit: boolean;
}

interface HarnessReport {
  schemaVersion: 1;
  startedAt: string;
  endedAt: string;
  debugMode: boolean;
  provider: { providerId: string; baseUrl: string; model: string };
  perCallTimeoutMs: number;
  totalCalls: number;
  completedCalls: number;
  counts: Record<CallRecord["outcome"], number>;
  firstLimitCall: number | null;
  /** firstLimitCall（含）之后的 (success+retry)/总数。null = 全程无限流。 */
  successRateAfterLimitInclusive: number | null;
  /** firstLimitCall（不含）之后的 (success+retry)/总数。 */
  successRateAfterLimitExclusive: number | null;
  verdict: "rolling" | "partial-rolling" | "hard-wall" | "no-limit" | "inconclusive";
  calls: CallRecord[];
}

const nowIso = () => new Date().toISOString();
const clip = (value: string | undefined, n: number) => (value ?? "").slice(0, n);

/** 一次失败/重试信号是否属于「限流/配额」家族（与 isDebugQuotaStopFailure 同口径）。 */
function isLimitFailure(failure: { reason: string; providerErrorCode?: string; statusCode?: number }): boolean {
  return (
    failure.reason === "rate_limited" ||
    failure.statusCode === 429 ||
    (failure.providerErrorCode !== undefined && QUOTA_CODES.has(failure.providerErrorCode))
  );
}

/** OpenRouter 免费档常把 429 细节放在 body；这里只按 status/码归一，正文留给 ledger。 */
function buildRegistry(apiKey: string, baseUrl: string, modelId: string): ProviderRegistry {
  const providerConfig = new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey }),
    api: new ProviderApiConfig({
      baseUrl,
      // OpenRouter 的归属展示头（可选但官方建议）；不影响认证。
      headers: { "X-Title": "zcode-debug-mode-harness" },
      type: "openai-chat-completions",
    }),
    builtinModelIds: [],
    personalModelIds: [modelId],
    visibility: "visible",
  }) as RegistryProviderConfig;
  const modelConfig = new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: false,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      // OpenRouter 全模型统一接受 max_tokens；上限压小让每轮又快又省。
      maxOutputTokens: { max: 256, map: '{"max_tokens": maxOutputTokens}' },
      reasoningLevel: { values: ["disabled"], map: "{}" },
    }),
  }) as RegistryModelConfig;
  return new ProviderRegistry([
    {
      providerId: PROVIDER_ID,
      providerName: "OpenRouter (debug-mode harness)",
      config: providerConfig,
      models: [{ modelId, config: modelConfig }],
    },
  ]);
}

function promptForCall(call: number): string {
  const a = (call * 7) % 90 + 3;
  const b = (call * 13) % 50 + 2;
  return `Reply with only the final number, nothing else: ${a} + ${b} = ?`;
}

async function main() {
  const argv = parseArgv();
  // core 侧的 isZCodeDebugModeEnabled() 读 process.env（无参调用）——
  // harness 进程本身就是被测进程，必须先落位再建 app。
  process.env.ZCODE_DEBUG_MODE = argv.debugMode ? "1" : "0";

  const outDir = join(process.cwd(), argv.outDir);
  await mkdir(outDir, { recursive: true });
  const ledgerPath = join(outDir, "ledger.jsonl");
  const reportPath = join(outDir, "report.json");

  const globalAbort = new AbortController();
  const onGlobalAbort = (signal: string) => {
    if (globalAbort.signal.aborted) return;
    process.stderr.write(`\n[harness] ${signal} — 中止剩余调用，写部分报告\n`);
    globalAbort.abort(new Error(`harness ${signal}`));
  };
  process.on("SIGINT", () => onGlobalAbort("SIGINT"));
  process.on("SIGTERM", () => onGlobalAbort("SIGTERM"));

  const registry = buildRegistry(argv.apiKey, argv.baseUrl, argv.model);
  const directory = await mkdtemp(join(tmpdir(), "zcode-debug-harness-"));
  const startedAt = nowIso();

  // 分片续跑：复用 ledger 里已记录的调用，只补剩下的。
  const records: CallRecord[] = [];
  if (argv.resume) {
    try {
      const previous = await readFile(ledgerPath, "utf8");
      // 同一调用号可能因旧版分片 bug 重复，保留最后一条。
      const byCall = new Map<number, CallRecord>();
      for (const line of previous.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = JSON.parse(trimmed) as CallRecord;
        byCall.set(record.call, record);
      }
      records.push(...[...byCall.values()]);
      const done = records.map((r) => r.call).sort((a, b) => a - b).join(",");
      process.stdout.write(`[harness] resume：已复用 ${records.length} 条记录（calls ${done}）\n`);
    } catch {
      process.stdout.write("[harness] resume：无既有 ledger，从 call 1 全量开始\n");
    }
  }
  const completedCalls = new Set(records.map((r) => r.call));

  process.stdout.write(
    `[harness] ZCODE_DEBUG_MODE=${process.env.ZCODE_DEBUG_MODE} model=${argv.model} calls=${argv.calls} ` +
      `perCallTimeout=${argv.timeoutMs}ms${argv.maxWallMs ? ` maxWall=${argv.maxWallMs}ms` : ""}\n[harness] ledger: ${ledgerPath}\n`,
  );

  const wallBudgetStarted = performance.now();
  let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;
  try {
    app = await createZCodeApp({
      env: { ...process.env, ZCODE_STORAGE_DIR: directory },
      skipUserConfig: true,
      pluginStorageRoot: join(directory, "plugins"),
      sourceTitle: "electron",
      providerRegistry: registry,
      modelIoFullRetentionEnabled: false,
      runtimeConfig: {
        workingDirectory: directory,
        modelSelection: {
          providerId: PROVIDER_ID,
          modelId: argv.model,
          options: { reasoningLevel: "disabled" },
        },
        modelStreaming: "on",
        toolAllowlist: [],
        toolSearch: { mode: "off" },
        mcp: { enabled: false },
        subagents: { enabled: false },
        titleGeneration: { enabled: false },
        dynamicWorkflowEnabled: false,
        memory: { enabled: false },
      },
    });

    for (let call = 1; call <= argv.calls; call += 1) {
      if (globalAbort.signal.aborted) break;
      if (completedCalls.has(call)) continue;
      // 墙钟预算：到点后不再开新调用（当前调用做完再收尾），下一片 --resume 续跑。
      if (argv.maxWallMs > 0 && performance.now() - wallBudgetStarted > argv.maxWallMs) {
        process.stdout.write(`[harness] wall 预算用完（${argv.maxWallMs}ms），做完前收尾——用 --resume 续跑\n`);
        break;
      }
      const prompt = promptForCall(call);
      const record: CallRecord = {
        call,
        prompt,
        startedAt: nowIso(),
        endedAt: "",
        durationMs: 0,
        outcome: "error",
        retries: [],
        failures: [],
        limitHit: false,
      };
      const callStarted = performance.now();
      let sawText = false;
      const onEvent = (event: SessionEvent) => {
        if (event.type === "model_network_status") {
          const payload = event.payload as Record<string, unknown>;
          const type = payload["type"];
          if (type === "model_retry_scheduled") {
            const signal: RetrySignal = {
              delayMs: Number(payload["delayMs"] ?? 0),
              nextAttempt: Number(payload["nextAttempt"] ?? 0),
              reason: String(payload["reason"] ?? ""),
              providerErrorCode: payload["providerErrorCode"] as string | undefined,
              statusCode: payload["statusCode"] as number | undefined,
            };
            record.retries.push(signal);
            if (isLimitFailure(signal)) record.limitHit = true;
            process.stdout.write(
              `  [call ${call}] retry scheduled: attempt=${signal.nextAttempt} delay=${signal.delayMs}ms ` +
                `reason=${signal.reason} providerCode=${signal.providerErrorCode ?? "-"} status=${signal.statusCode ?? "-"}\n`,
            );
          } else if (type === "model_request_failed") {
            const signal: FailureSignal = {
              reason: String(payload["reason"] ?? ""),
              retryable: payload["retryable"] === true,
              providerErrorCode: payload["providerErrorCode"] as string | undefined,
              statusCode: payload["statusCode"] as number | undefined,
              message: clip(payload["message"] as string | undefined, 160),
            };
            record.failures.push(signal);
            if (isLimitFailure(signal)) record.limitHit = true;
            process.stdout.write(
              `  [call ${call}] request failed: reason=${signal.reason} retryable=${signal.retryable} ` +
                `providerCode=${signal.providerErrorCode ?? "-"} status=${signal.statusCode ?? "-"} ${signal.message}\n`,
            );
          }
        } else if (event.type === "turn_error") {
          const error = (event.payload as Record<string, unknown>)["error"] as
            | { code?: string; message?: string }
            | undefined;
          record.turnError = { code: error?.code, message: clip(error?.message, 200) };
        } else if (event.type === "model_streaming" && !sawText) {
          const payload = event.payload as Record<string, unknown>;
          if (payload["kind"] === "text_delta" && payload["delta"]) {
            sawText = true;
            record.firstTextMs = Math.round(performance.now() - callStarted);
          }
        }
      };

      try {
        const result = await app.submitPrompt(prompt, {
          onEvent,
          abortSignal: AbortSignal.any([
            globalAbort.signal,
            AbortSignal.timeout(argv.timeoutMs),
          ]),
          modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
        });
        record.outcome = record.limitHit ? "retry" : "success";
        record.response = clip(result.response, 200);
      } catch (error) {
        const aborted =
          globalAbort.signal.aborted ||
          (error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`));
        if (aborted) record.aborted = globalAbort.signal.aborted ? "global-abort" : "per-call-timeout";
        const turnErrorIsRateLimit =
          record.turnError?.code === "model_rate_limited" ||
          (record.turnError !== undefined && /rate.?limit|quota|429/i.test(record.turnError.message));
        if (record.limitHit || turnErrorIsRateLimit) record.outcome = "quota-stop";
        else record.turnError ??= { message: clip(error instanceof Error ? error.message : String(error), 200) };
      }
      record.endedAt = nowIso();
      record.durationMs = Math.round(performance.now() - callStarted);
      records.push(record);
      // 逐调用落盘：任何时刻中止都有完整 ledger。
      await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
      const summary =
        record.outcome === "success" || record.outcome === "retry"
          ? `resp=${JSON.stringify(record.response ?? "")}`
          : `aborted=${record.aborted ?? "-"} turnError=${JSON.stringify(record.turnError?.message ?? "")}`;
      process.stdout.write(
        `[${String(record.call).padStart(2, "0")}/${argv.calls}] ${record.outcome.toUpperCase().padEnd(10)} ` +
          `${(record.durationMs / 1000).toFixed(1)}s limit=${record.limitHit ? "Y" : "n"} ${summary}\n`,
      );
    }
  } finally {
    try {
      await app?.close?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // 分片续跑后 records 可能乱序；统一按调用号排序再统计。
  records.sort((a, b) => a.call - b.call);
  const counts: Record<CallRecord["outcome"], number> = {
    success: 0,
    retry: 0,
    "quota-stop": 0,
    error: 0,
  };
  for (const record of records) counts[record.outcome] += 1;
  const firstLimitIndex = records.findIndex((r) => r.limitHit);
  const firstLimitCall = firstLimitIndex >= 0 ? records[firstLimitIndex]!.call : null;
  const fromFirstLimit = firstLimitIndex >= 0 ? records.slice(firstLimitIndex) : [];
  const fromAfterFirstLimit = firstLimitIndex >= 0 ? records.slice(firstLimitIndex + 1) : [];
  const recovered = (rows: CallRecord[]) =>
    rows.filter((r) => r.outcome === "success" || r.outcome === "retry").length;
  const inclusiveRate = fromFirstLimit.length ? recovered(fromFirstLimit) / fromFirstLimit.length : null;
  const exclusiveRate = fromAfterFirstLimit.length
    ? recovered(fromAfterFirstLimit) / fromAfterFirstLimit.length
    : null;

  let verdict: HarnessReport["verdict"] = "inconclusive";
  if (firstLimitIndex < 0) verdict = "no-limit";
  else if (inclusiveRate !== null && inclusiveRate === 0) verdict = "hard-wall";
  else if (inclusiveRate !== null && inclusiveRate >= 1) verdict = "rolling";
  else verdict = "partial-rolling";

  const report: HarnessReport = {
    schemaVersion: 1,
    startedAt,
    endedAt: nowIso(),
    debugMode: argv.debugMode,
    provider: { providerId: PROVIDER_ID, baseUrl: argv.baseUrl, model: argv.model },
    perCallTimeoutMs: argv.timeoutMs,
    totalCalls: argv.calls,
    completedCalls: records.length,
    counts,
    firstLimitCall,
    successRateAfterLimitInclusive: inclusiveRate,
    successRateAfterLimitExclusive: exclusiveRate,
    verdict,
    calls: records,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    `\n[harness] 完成 ${records.length}/${argv.calls} 轮：success=${counts.success} retry=${counts.retry} ` +
      `quota-stop=${counts["quota-stop"]} error=${counts.error}\n` +
      `[harness] 首次限流：call ${firstLimitCall ?? "-"}；success-rate-after-limit（含）` +
      `${inclusiveRate === null ? "n/a" : `${(inclusiveRate * 100).toFixed(1)}%`}（不含首发）` +
      `${exclusiveRate === null ? "n/a" : `${(exclusiveRate * 100).toFixed(1)}%`}\n` +
      `[harness] 判定：${verdict}（rolling=软性滚动执行 / hard-wall=硬性服务端墙 / ` +
      `partial-rolling=部分恢复 / no-limit=未触发限流）\n` +
      `[harness] 报告：${reportPath}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[harness] 致命错误：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
