#!/usr/bin/env node
/* Task 4 验证驱动：fresh-install fixture + live-server registration（spec：
   apps/zcode-cli/docs/design/v2/install-identity-lifecycle.md §7）。

   四个证明阶段（全部断言通过 => verdict: pass）：
   1. reset-proof     seed 一个「用过」的 .zcode → 跑 reset-install-state.sh --apply → 全灭 + 幂等；
   2. fresh-identity  reset 后经产品路径（prepareModelTelemetryEnv，双 env 轴成对注入）
                      生成 deviceMid；再 reset 再生成 → 两次 ID 不同（干净机器=全新随机身份）；
   3. fresh-gating    hasConfiguredStandaloneCodingPlan() === false（未注册态）；
   4. live-registration 对生产 https://zcode.z.ai：注入全新 ZCODE_CREDENTIAL_SECRET
                      （headless 的干净 keychain 等价）→ loginZCodeCli({noBrowser:true})：
                      onAuthorizeUrl 拿到真实 authorize_url+flow_id（服务端登记登录流=grant 发起）、
                      onPollStatus 观察 live pending、到期抛 auth_timeout、无任何凭据落盘。

   子阶段：--phase=device-mid 由本驱动 spawn 自身，在独立进程里生成 deviceMid
   （模块级缓存按状态文件路径驻留进程内，同进程 reset 后会读到旧值）。

   运行：
     pnpm install 后：../../node_modules/.bin/tsx src/verify-fresh-registration.ts
   常用参数：--login-window-ms=N（默认 15000，live 阶段观察窗口） */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import process from "node:process";
import {
  hasConfiguredStandaloneCodingPlan,
  loginZCodeCli,
  ZCodeCliLoginError,
} from "@zcode/bootstrap";
import { prepareModelTelemetryEnv, shutdownPreparedModelTelemetry } from "@zcode/telemetry";
import {
  NodeZCodeBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveZCodeBuiltinCachePaths,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { resolveRuntimeZCodeEndpointOrigin, ZCODE_VERSION } from "@zcode/shared";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(TOOL_DIR, "..", "reset-install-state.sh");
const REPO_ROOT = join(TOOL_DIR, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
/** CLI 随包基线（真入口的 ../../../../../config/provider/zcode-builtin.json 等价物）。 */
const BUNDLED_CATALOG = join(REPO_ROOT, "config", "provider", "zcode-builtin.json");

interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  results.push({ check: name, pass, detail: detail ? String(detail).slice(0, 400) : undefined });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function fixtureEnv(baseDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // 双 env 轴成对注入（审计 §2.3）：ZCODE_DATA_BASE_DIR 指父目录，ZCODE_HOME 指 .zcode 本身。
  return {
    ...process.env,
    ZCODE_DATA_BASE_DIR: baseDir,
    ZCODE_HOME: join(baseDir, ".zcode"),
    HOME: baseDir,
    ...extra,
  };
}

async function runReset(baseDir: string): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("/bin/bash", [SCRIPT, "--base-dir", baseDir, "--apply"], {
      env: { ...process.env, ZCODE_DATA_BASE_DIR: baseDir },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`reset exited ${code}: ${stdout}`)),
    );
  });
  process.stdout.write(
    output
      .split("\n")
      .map((line) => `    | ${line}`)
      .join("\n") + "\n",
  );
  return output;
}

/**
 * 与 CLI 入口 prepareCliProviderRuntimeEnv 同构（产品路径）：随包基线 → 首启动
 * 物化 active 缓存（<base>/.zcode/v2/runtime/provider/...）→ 注入两个 env。
 */
async function prepareProviderRuntimeEnv(
  baseDir: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const cachePaths = resolveZCodeBuiltinCachePaths({
    environmentConfigRoot: join(baseDir, ".zcode", "v2"),
    platform: resolveZCodeBuiltinClientPlatform(),
    appVersion: ZCODE_VERSION,
    zcodeEndpointOrigin: resolveRuntimeZCodeEndpointOrigin(env),
  });
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: BUNDLED_CATALOG,
    activeFilePath: cachePaths.activeFilePath,
    watch: false,
  });
  try {
    await source.read();
  } finally {
    source.dispose();
  }
  return {
    ...env,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(
      baseDir,
      ".zcode",
      "v2",
      PERSONAL_PROVIDER_CONFIG_FILE_NAME,
    ),
  };
}

/** 本地 OTLP sink：吸收 telemetry owner 的导出（127.0.0.1，不触网）。 */
async function startOtlpSink(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("otlp sink address unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface DeviceMidPhaseResult {
  deviceMid: string;
}

/** 子进程阶段：产品路径生成 deviceMid，并把结果打到 stdout（JSON 一行）。 */
async function deviceMidPhase(otlpUrl: string): Promise<void> {
  const baseDir = process.env.ZCODE_DATA_BASE_DIR;
  if (!baseDir) throw new Error("device-mid phase requires ZCODE_DATA_BASE_DIR");
  const env = fixtureEnv(baseDir, {
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl,
    ZCODE_MODEL_TELEMETRY_ENABLED: "1",
  });
  await prepareModelTelemetryEnv(env);
  await shutdownPreparedModelTelemetry();
  const state = JSON.parse(
    await readFile(join(baseDir, ".zcode", "v2", "telemetry-state.json"), "utf8"),
  ) as { deviceMid?: string };
  if (!state.deviceMid) throw new Error("deviceMid missing after prepareModelTelemetryEnv");
  process.stdout.write(`${JSON.stringify({ deviceMid: state.deviceMid } satisfies DeviceMidPhaseResult)}\n`);
}

function spawnDeviceMidPhase(
  baseDir: string,
  otlpUrl: string,
): Promise<{ deviceMid: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [join(TOOL_DIR, "verify-fresh-registration.ts"), "--phase=device-mid", `--otlp-url=${otlpUrl}`], {
      env: fixtureEnv(baseDir, { OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl }),
    });
    let raw = "";
    child.stdout.on("data", (chunk) => (raw += chunk));
    child.stderr.on("data", (chunk) => (raw += chunk));
    child.on("close", (code) => {
      const line = raw.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (code === 0 && line) {
        try {
          resolve(JSON.parse(line) as { deviceMid: string });
          return;
        } catch {
          /* 落到 reject。 */
        }
      }
      reject(new Error(`device-mid phase exited ${code}: ${raw.slice(0, 400)}`));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = args.find((candidate) => candidate.startsWith(`--${name}=`));
    if (hit !== undefined) return hit.slice(name.length + 3);
    return args.includes(`--${name}`) ? "1" : undefined;
  };
  const otlpUrlArg = flag("otlp-url");
  if (flag("phase") === "device-mid") {
    if (!otlpUrlArg) throw new Error("device-mid phase requires --otlp-url");
    await deviceMidPhase(otlpUrlArg);
    return;
  }
  const loginWindowMs = Number(flag("login-window-ms") ?? 15_000);

  console.log("== Task 4: fresh-install fixture verification ==");

  // ---- Phase 1: reset-proof -------------------------------------------------
  console.log("[1/4] reset-proof (seed used machine → reset-install-state.sh --apply)");
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-fresh-"));
  const zcodeDir = join(baseDir, ".zcode");
  await mkdir(join(zcodeDir, "v2"), { recursive: true });
  await mkdir(join(zcodeDir, "cli"), { recursive: true });
  await writeFile(
    join(zcodeDir, "v2", "telemetry-state.json"),
    `${JSON.stringify({ deviceMid: "stale-device-mid-00000000" }, null, 2)}\n`,
  );
  await writeFile(
    join(zcodeDir, "v2", "credentials.json"),
    `${JSON.stringify({ "oauth:zai:access_token": "enc:v1:stale" }, null, 2)}\n`,
  );
  await writeFile(join(zcodeDir, "v2", "provider_config.json"), "{}\n");
  await writeFile(join(zcodeDir, "cli", "config.json"), `${JSON.stringify({ ui: { theme: "dark" } })}\n`);
  await writeFile(join(zcodeDir, "v2", "credential-source"), "os\n");
  await writeFile(join(zcodeDir, "v2", "credential-secret"), `${randomBytes(32).toString("base64url")}\n`, {
    mode: 0o600,
  });
  const seeded = await exists(zcodeDir);
  check("seeded used-machine .zcode state", seeded);
  const resetOutput = await runReset(baseDir);
  check("reset script removed .zcode root", !(await exists(zcodeDir)), resetOutput.split("\n").find((line) => line.includes("reset")));
  const idempotent = await runReset(baseDir);
  check(
    "reset idempotent (already-pristine on second run)",
    idempotent.includes("already-pristine"),
  );

  // ---- Phase 2: fresh-identity ----------------------------------------------
  console.log("[2/4] fresh-identity (deviceMid regeneration via product path)");
  const sink = await startOtlpSink();
  try {
    const first = await spawnDeviceMidPhase(baseDir, sink.url);
    check(
      "clean machine generated a fresh deviceMid (not the seeded stale one)",
      /^[0-9a-f-]{36}$/iu.test(first.deviceMid) && first.deviceMid !== "stale-device-mid-00000000",
      first.deviceMid,
    );
    await runReset(baseDir);
    const second = await spawnDeviceMidPhase(baseDir, sink.url);
    check(
      "second clean install generated a different deviceMid",
      second.deviceMid !== first.deviceMid,
      `${first.deviceMid} → ${second.deviceMid}`,
    );
  } finally {
    await sink.stop();
  }

  // ---- Phase 3: fresh-gating -------------------------------------------------
  console.log("[3/4] fresh-gating (unregistered first-launch state)");
  const freshEnv = fixtureEnv(baseDir);
  const providerRuntimeEnv = await prepareProviderRuntimeEnv(baseDir, freshEnv);
  const configured = await hasConfiguredStandaloneCodingPlan({ env: providerRuntimeEnv });
  check("hasConfiguredStandaloneCodingPlan === false on fresh machine", configured === false);

  // ---- Phase 4: live-registration --------------------------------------------
  console.log("[4/4] live-registration (loginZCodeCli against https://zcode.z.ai)");
  // headless Linux 无 Secret Service：全新随机 secret = 干净 keychain 的确定性等价（审计 §4）。
  const secret = randomBytes(32).toString("base64url");
  const loginEnv = fixtureEnv(baseDir, {
    ZCODE_CREDENTIAL_SECRET: secret,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]!,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]!,
  });
  let authorizeUrl = "";
  let flowId = "";
  let pendingPolls = 0;
  let loginError: unknown;
  try {
    await loginZCodeCli({
      env: loginEnv,
      noBrowser: true,
      timeoutMs: loginWindowMs,
      onAuthorizeUrl: (data) => {
        authorizeUrl = data.authorize_url;
        flowId = data.flow_id;
        console.log(`    authorize_url: ${authorizeUrl}`);
        console.log(`    flow_id: ${flowId}  expires_at: ${data.expires_at}`);
      },
      onPollStatus: (data) => {
        if (data.status === "pending") pendingPolls += 1;
      },
    });
  } catch (error) {
    loginError = error;
  }
  check(
    "live server issued authorize_url + flow_id (login flow registered server-side)",
    authorizeUrl.startsWith("https://") && flowId.length > 0,
    `flow_id=${flowId}`,
  );
  check(
    "live poll loop observed pending status",
    pendingPolls > 0,
    `pending polls: ${pendingPolls}`,
  );
  const timeoutAsExpected =
    loginError instanceof ZCodeCliLoginError && loginError.code === "auth_timeout";
  check(
    "unfinished login ended with auth_timeout (nobody authorized in browser)",
    timeoutAsExpected,
    loginError instanceof Error ? `${loginError.name}: ${loginError.message}` : "no error thrown",
  );
  const credentialsPath = join(zcodeDir, "v2", "credentials.json");
  const providerConfigPath = join(zcodeDir, "v2", "provider_config.json");
  check(
    "abandoned login left no credentials.json / provider_config.json",
    !(await exists(credentialsPath)) && !(await exists(providerConfigPath)),
  );
  console.log(
    "    (human last-mile: open authorize_url above in a browser and approve to issue the grant;",
  );
  console.log("     the automated window only proves server-side registration + live polling)");

  // ---- verdict ---------------------------------------------------------------
  const failed = results.filter((result) => !result.pass);
  console.log("");
  console.log(
    `verdict: ${failed.length === 0 ? "pass" : "FAIL"}  (${results.length - failed.length}/${results.length} checks passed)`,
  );
  if (authorizeUrl) console.log(`authorize_url: ${authorizeUrl}`);
  await rm(baseDir, { recursive: true, force: true });
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
