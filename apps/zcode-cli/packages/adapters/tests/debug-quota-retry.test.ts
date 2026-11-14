import { describe, expect, it, vi, beforeAll } from "vitest";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import { ensureCliDeviceMid } from "../src/device/cli-device-mid.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import {
  DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS,
  DEBUG_QUOTA_PROBE_BACKOFF_MAX_MS,
  DEBUG_QUOTA_PROBE_MIN_SPACING_MS,
  debugQuotaProbeDelayMs,
  isDebugQuotaStopFailure,
} from "../src/model/debug-quota-retry.js";
import { ModelFailureReason } from "@zcode/contracts";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const TEST_DEBUG_QUOTA_PROVIDER_ID = "debug-quota-provider";

// ZCODE_DEBUG_MODE（spec：apps/zcode-cli/docs/design/v2/debug-mode.md）：
// 配额/限流类停止改走患者探测——预算豁免、60s→10min→…→1h 升梯、Retry-After 不参与间隔；
// flag off 一切路径逐字不变（终止、预算、警告）。两侧都要有回归证明。

function debugQuotaRegistryConfig() {
  return {
    providers: {
      [TEST_DEBUG_QUOTA_PROVIDER_ID]: {
        kind: "anthropic" as const,
        apiKey: "key",
        baseURL: "http://127.0.0.1:9/debug-quota/anthropic",
      },
    },
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** 配额 429（1308）：Retry-After 故意指向额度窗口结束（1 小时）——探测间隔必须无视它。 */
function quota429(retryAfterSeconds = 3_600): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: "1308",
    providerId: TEST_DEBUG_QUOTA_PROVIDER_ID,
    providerKind: "anthropic",
    providerMessage: "您的限额将在 2026-10-15 18:50:42 重置。",
    responseHeaders: { "retry-after": String(retryAfterSeconds) },
    responseStatus: 429,
    statusCode: 429,
  });
}

function makeAdapter(runtime: AiSdkModelRuntime, maxAttempts: number, debugMode: boolean) {
  return new AiSdkModelAdapter({
    ...(debugMode ? { env: { ZCODE_DEBUG_MODE: "1" } } : {}),
    registry: new TestProviderConfigFixture(debugQuotaRegistryConfig()),
    retry: { baseDelayMs: 0, jitter: false, maxAttempts },
    runtime,
  });
}

beforeAll(async () => {
  // 一次性预热 device-mid 缓存（真实定时器）：anthropic 元数据解析在首个模型调用前有一次
  // fs 宏任务边界，fake timers 的 advance/runAll 冲不到它——预热后链路纯微任务，升梯定时器可控推进。
  await ensureCliDeviceMid();
});

describe("debugQuotaProbeDelayMs 升梯（纯函数）", () => {
  it("1 → 60s；2 → 10min；3 → 20min；4 → 40min；≥5 → 1h 封顶", () => {
    expect(debugQuotaProbeDelayMs(1)).toBe(DEBUG_QUOTA_PROBE_MIN_SPACING_MS);
    expect(debugQuotaProbeDelayMs(2)).toBe(DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS);
    expect(debugQuotaProbeDelayMs(3)).toBe(2 * DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS);
    expect(debugQuotaProbeDelayMs(4)).toBe(4 * DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS);
    expect(debugQuotaProbeDelayMs(5)).toBe(DEBUG_QUOTA_PROBE_BACKOFF_MAX_MS);
    expect(debugQuotaProbeDelayMs(6)).toBe(DEBUG_QUOTA_PROBE_BACKOFF_MAX_MS);
    expect(debugQuotaProbeDelayMs(100)).toBe(DEBUG_QUOTA_PROBE_BACKOFF_MAX_MS);
  });

  it("非有限值与 ≤1 一律按首次 60s 处理", () => {
    expect(debugQuotaProbeDelayMs(0)).toBe(DEBUG_QUOTA_PROBE_MIN_SPACING_MS);
    expect(debugQuotaProbeDelayMs(-3)).toBe(DEBUG_QUOTA_PROBE_MIN_SPACING_MS);
    expect(debugQuotaProbeDelayMs(Number.NaN)).toBe(DEBUG_QUOTA_PROBE_MIN_SPACING_MS);
    expect(debugQuotaProbeDelayMs(Number.POSITIVE_INFINITY)).toBe(
      DEBUG_QUOTA_PROBE_MIN_SPACING_MS,
    );
  });
});

describe("isDebugQuotaStopFailure 判定（纯函数）", () => {
  it("配额业务码（与 workflow 策略表同源）优先于 reason", () => {
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.AuthFailed }, "1308")).toBe(true);
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.AuthFailed }, "insufficient_quota"))
      .toBe(true);
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.Unknown }, "1005")).toBe(true);
  });

  it("reason = rate_limited（无业务码的裸 429 / 预算耗尽）也算配额类", () => {
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.RateLimited }, undefined)).toBe(
      true,
    );
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.RateLimited }, "1311")).toBe(true);
  });

  it("其余（auth / invalid_request / 5xx / 网络 / Start-Plan busy 3008）不受影响", () => {
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.AuthFailed }, undefined)).toBe(
      false,
    );
    expect(
      isDebugQuotaStopFailure({ reason: ModelFailureReason.InvalidRequest }, undefined),
    ).toBe(false);
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.ServerError }, undefined)).toBe(
      false,
    );
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.NetworkError }, undefined)).toBe(
      false,
    );
    expect(isDebugQuotaStopFailure({ reason: ModelFailureReason.AuthFailed }, "3008")).toBe(false);
  });
});

describe("ZCODE_DEBUG_MODE 患者探测（generate 路径）", () => {
  it("配额 429 豁免重试预算：按升梯探测直至成功，间隔无视 Retry-After", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const retryDelays: Array<number | undefined> = [];
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          calls += 1;
          if (calls <= 3) throw quota429(); // retry-after 1 小时：探测间隔必须无视它
          return {
            text: "done",
            finishReason: "stop",
            usage: usage(1, 1),
            totalUsage: usage(1, 1),
          } as never;
        },
        streamText() {
          throw new Error("not used");
        },
      };
      const adapter = makeAdapter(runtime, 2, true); // 预算仅 2 次
      const pending = executeAdapterGenerateText(adapter, {
        providerId: TEST_DEBUG_QUOTA_PROVIDER_ID as never,
        modelId: "GLM-5.2" as never,
        messages: [{ role: "user", content: "ping" }],
        statusSink: {
          publish(event) {
            if (event.type === "model_retry_scheduled") retryDelays.push(event.delayMs);
          },
        } as never,
      });
      // 升梯有限（3 次失败后成功）：逐档推进——每次 advance 前链路已把下一档定时器排上。
      await vi.advanceTimersByTimeAsync(DEBUG_QUOTA_PROBE_MIN_SPACING_MS);
      await vi.advanceTimersByTimeAsync(DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS);
      await vi.advanceTimersByTimeAsync(2 * DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS);
      const result = await pending;
      expect(result.text).toBe("done");
      expect(calls).toBe(4); // 3 次配额停止 + 1 次成功 > maxAttempts=2
      // 间隔走升梯而不是 Retry-After（1 小时）也不是 Default 的指数曲线。
      expect(retryDelays).toEqual([
        DEBUG_QUOTA_PROBE_MIN_SPACING_MS,
        DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS,
        2 * DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("回归：flag off 时配额 429 仍是终止失败（预算如常，一次即停）", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        throw quota429();
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = makeAdapter(runtime, 5, false);
    const error = await executeAdapterGenerateText(adapter, {
      providerId: TEST_DEBUG_QUOTA_PROVIDER_ID as never,
      modelId: "GLM-5.2" as never,
      messages: [{ role: "user", content: "ping" }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ context: { providerCode: "1308" } });
    expect(calls).toBe(1); // 终止映射：不重试
  });
});

describe("ZCODE_DEBUG_MODE 患者探测（stream 路径）", () => {
  it("SSE 首块前的配额 429 豁免预算，按升梯探测，准入后正常出流", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const runtime: AiSdkModelRuntime = {
        generateText() {
          throw new Error("not used");
        },
        streamText() {
          calls += 1;
          if (calls <= 2) {
            return {
              // eslint-disable-next-line require-yield -- 模拟流启动即抛错
              fullStream: (async function* () {
                throw quota429();
              })(),
            } as never;
          }
          return {
            fullStream: (async function* () {
              yield { type: "text-delta", id: "t1", text: "done" };
              yield { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) };
            })(),
          } as never;
        },
      };
      const adapter = makeAdapter(runtime, 2, true);
      const events: unknown[] = [];
      const pending = (async () => {
        for await (const event of executeAdapterStreamText(adapter, {
          providerId: TEST_DEBUG_QUOTA_PROVIDER_ID as never,
          modelId: "GLM-5.2" as never,
          messages: [{ role: "user", content: "ping" }],
        })) {
          events.push(event);
        }
      })();
      await vi.advanceTimersByTimeAsync(DEBUG_QUOTA_PROBE_MIN_SPACING_MS);
      await vi.advanceTimersByTimeAsync(DEBUG_QUOTA_PROBE_BACKOFF_BASE_MS);
      await pending;
      expect(calls).toBe(3); // 2 次配额停止 + 1 次成功 > maxAttempts=2
      expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("回归：flag off 时 SSE 配额 429 落败（不重试）", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText() {
        calls += 1;
        return {
          // eslint-disable-next-line require-yield -- 模拟流启动即抛错
          fullStream: (async function* () {
            throw quota429();
          })(),
        } as never;
      },
    };
    const adapter = makeAdapter(runtime, 5, false);
    const error = await (async () => {
      try {
        for await (const _event of executeAdapterStreamText(adapter, {
          providerId: TEST_DEBUG_QUOTA_PROVIDER_ID as never,
          modelId: "GLM-5.2" as never,
          messages: [{ role: "user", content: "ping" }],
        })) {
          // drain
        }
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ context: { providerCode: "1308" } });
    expect(calls).toBe(1);
  });
});
