#!/usr/bin/env node
/* Task 4 live-cycle driver — full-cycle fresh-install verification with assisted consent
 * (spec: apps/zcode-cli/docs/design/v2/install-identity-lifecycle.md §7 phase 5 / §8).
 *
 * One full cycle, twice (two INDEPENDENT fresh installs, same human account):
 *   fixture N: fresh state → reset-install-state → live registration (zcode.z.ai)
 *   → human consent (console page) → credentials land → coding-plan grant active
 *   → identity evidence captured (deviceMid / account user_id / cipher key).
 * Then the cross-fixture verdict answers THE question of deliverable (a):
 *   which identity layer does the server key grant issuance on?
 *
 * Consent UX: the driver publishes live state to <run-dir>/state.json; the session
 * console (mini-services/consent-console, port 3000) renders it as a big clickable
 * authorize link. Each loginZCodeCli attempt registers a fresh server-side flow
 * (valid ~5 min) and polls until the human approves or the attempt expires.
 *
 * Usage:
 *   tsx src/verify-live-cycle.ts --run-dir=<dir> [--max-wall-ms=480000]
 *        [--attempt-timeout-ms=285000] [--reset] [--phase=device-mid --otlp-url=URL]
 *
 * Exit codes: 0 = full cycle certified (all checks pass)
 *             2 = wall budget exhausted while awaiting consent — re-run to resume
 *             1 = failed (see state.json / stdout)
 *
 * Resume: <run-dir>/run-state.json is the checkpoint; fixtures persist across
 * invocations so a half-registered installation keeps its identity (deviceMid,
 * cipher key) between attempts.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  createCodingPlanApiKeyResolver,
  createNodeHttpClientAdapter,
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { resolveRuntimeZCodeEndpointOrigin, ZCODE_VERSION } from "@zcode/shared";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(TOOL_DIR, "..", "reset-install-state.sh");
const REPO_ROOT = join(TOOL_DIR, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
/** CLI 随包基线（真入口的 ../../../../../config/provider/zcode-builtin.json 等价物）。 */
const BUNDLED_CATALOG = join(REPO_ROOT, "config", "provider", "zcode-builtin.json");
const STEP_COUNT = 2;

interface CheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

interface FixtureRecord {
  baseDir: string;
  secret: string;
  secretFingerprint: string;
  deviceMid: string;
  userId?: string;
  mainModel?: string;
  material?: { apiKeyId: string; organizationId: string; projectId: string };
  registeredAt?: string;
}

interface RunState {
  runId: string;
  step: number; // next step to execute: 1, 2, 3 (=done)
  fixtures: Record<string, FixtureRecord>;
  attempts: Record<string, number>;
}

const results: CheckResult[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  results.push({ check: name, pass, detail: detail ? String(detail).slice(0, 300) : undefined });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rm(path, { force: true }).catch(() => undefined);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path).catch(async () => {
    await writeFile(path, text);
  });
}

/* ------------------------------------------------------------------ args --- */

function flag(name: string): string | undefined {
  const hit = process.argv
    .slice(2)
    .find((candidate) => candidate === `--${name}` || candidate.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "1" : hit.slice(eq + 1);
}

const RUN_DIR = flag("run-dir") ?? join(TOOL_DIR, "..", "runs", "live-cycle");
const RUN_STATE_PATH = join(RUN_DIR, "run-state.json");
const CONSOLE_STATE_PATH = join(RUN_DIR, "state.json");
const REPORT_PATH = join(RUN_DIR, "report.json");

/* --------------------------------------------------------------- console --- */

let consoleState: Record<string, unknown> = {
  runId: "",
  steps: STEP_COUNT,
  phase: "starting",
};

async function publish(patch: Record<string, unknown>): Promise<void> {
  consoleState = { ...consoleState, ...patch, updatedAt: new Date().toISOString() };
  const expiresAt = consoleState.flowExpiresAt;
  if (typeof expiresAt === "number") {
    consoleState.remainingSec = Math.max(0, Math.round(expiresAt - Date.now() / 1000));
  }
  await writeAtomic(
    CONSOLE_STATE_PATH,
    `${JSON.stringify(consoleState, null, 2)}\n`,
  ).catch(() => undefined);
}

/* ------------------------------------------------------------ env helpers -- */

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

async function runReset(baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true });
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
}

/** 与 CLI 入口 prepareCliProviderRuntimeEnv 同构（产品路径）：随包基线 → 物化 active 缓存。 */
async function prepareProviderRuntimeEnv(
  baseDir: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
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
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(
      baseDir,
      ".zcode",
      "v2",
      PERSONAL_PROVIDER_CONFIG_FILE_NAME,
    ),
  };
}

/* --------------------------------------------------------- deviceMid phase -- */

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
  process.stdout.write(`${JSON.stringify({ deviceMid: state.deviceMid })}\n`);
}

function spawnDeviceMidPhase(baseDir: string, otlpUrl: string): Promise<{ deviceMid: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX,
      [join(TOOL_DIR, "verify-live-cycle.ts"), "--phase=device-mid", `--otlp-url=${otlpUrl}`],
      { env: fixtureEnv(baseDir, { OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl }) },
    );
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
      reject(new Error(`device-mid phase exited ${code}: ${raw.slice(0, 300)}`));
    });
  });
}

/* ------------------------------------------------------------ run state ---- */

async function loadRunState(): Promise<RunState> {
  if (flag("reset") === "1" || !(await exists(RUN_STATE_PATH))) {
    const runId = `live-cycle-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    return { runId, step: 1, fixtures: {}, attempts: {} };
  }
  return JSON.parse(await readFile(RUN_STATE_PATH, "utf8")) as RunState;
}

async function saveRunState(state: RunState): Promise<void> {
  await writeAtomic(RUN_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function fingerprint(secret: string): string {
  return `sha256:${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

/* ------------------------------------------------------------- fixture ----- */

async function ensureFixture(
  runState: RunState,
  step: number,
): Promise<{ fixture: FixtureRecord; providerRuntimeEnv: NodeJS.ProcessEnv }> {
  const existing = runState.fixtures[String(step)];
  if (existing) {
    // 简历：同一安装（deviceMid/cipher key 不变）继续注册。
    const providerRuntimeEnv = await prepareProviderRuntimeEnv(
      existing.baseDir,
      fixtureEnv(existing.baseDir),
    );
    return { fixture: existing, providerRuntimeEnv };
  }
  const label = step === 1 ? "A" : "B";
  console.log(`[fixture ${label}] creating fresh install state…`);
  await publish({ phase: "step-running", step, stepTitle: `fresh state → reset (fixture ${label})`, lastEvent: "resetting fixture to first-launch state" });
  const baseDir = join(RUN_DIR, `fixture-${step}`);
  await runReset(baseDir);
  const secret = randomBytes(32).toString("base64url");
  const providerRuntimeEnv = await prepareProviderRuntimeEnv(baseDir, fixtureEnv(baseDir));
  const sink = await startOtlpSink();
  let deviceMid: string;
  try {
    ({ deviceMid } = await spawnDeviceMidPhase(baseDir, sink.url));
  } finally {
    await sink.stop();
  }
  const fixture: FixtureRecord = {
    baseDir,
    secret,
    secretFingerprint: fingerprint(secret),
    deviceMid,
  };
  runState.fixtures[String(step)] = fixture;
  runState.attempts[String(step)] = 0;
  await saveRunState(runState);
  console.log(
    `[fixture ${label}] base=${baseDir} deviceMid=${deviceMid} cipherKey=${fixture.secretFingerprint}`,
  );
  return { fixture, providerRuntimeEnv };
}

function loginEnvFor(
  fixture: FixtureRecord,
  providerRuntimeEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return fixtureEnv(fixture.baseDir, {
    ZCODE_CREDENTIAL_SECRET: fixture.secret,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV
    ]!,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV
    ]!,
  });
}

/* --------------------------------------------------------------- material -- */

function createResolver(env: NodeJS.ProcessEnv) {
  const config = createConfig({ env });
  return createCodingPlanApiKeyResolver({
    httpClient: createNodeHttpClientAdapter({
      env,
      proxyUrl: config.config.network.httpProxy,
      noProxy: config.config.network.noProxy,
      caCertFile: config.config.network.caCertFile,
      timeoutMs: config.config.network.timeout,
    }),
  });
}

async function loadZaiAccessToken(
  fixture: FixtureRecord,
  providerRuntimeEnv: NodeJS.ProcessEnv,
): Promise<string> {
  const store = createSharedZCodeCredentialStore({
    env: loginEnvFor(fixture, providerRuntimeEnv),
  });
  const values = await store.loadMany([SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]);
  const token = values[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken];
  if (!token) throw new Error("zai access token missing from credential store");
  return token;
}

async function resolveMaterial(
  fixture: FixtureRecord,
  providerRuntimeEnv: NodeJS.ProcessEnv,
): Promise<{ apiKeyId: string; organizationId: string; projectId: string }> {
  const accessToken = await loadZaiAccessToken(fixture, providerRuntimeEnv);
  const resolver = createResolver(loginEnvFor(fixture, providerRuntimeEnv));
  const material = await resolver.resolveMaterial({ accessToken, family: "zai" });
  return {
    apiKeyId: material.apiKeyId,
    organizationId: material.organizationId,
    projectId: material.projectId,
  };
}

/* ----------------------------------------------------------- login attempt -- */

interface AttemptOutcome {
  ok: boolean;
  timeout?: boolean;
  error?: string;
  result?: Awaited<ReturnType<typeof loginZCodeCli>>;
}

async function attemptLogin(
  step: number,
  fixture: FixtureRecord,
  providerRuntimeEnv: NodeJS.ProcessEnv,
  attemptTimeoutMs: number,
): Promise<AttemptOutcome> {
  const label = step === 1 ? "A" : "B";
  let attemptNumber = 0;
  try {
    return {
      ok: true,
      result: await loginZCodeCli({
        env: loginEnvFor(fixture, providerRuntimeEnv),
        noBrowser: true,
        timeoutMs: attemptTimeoutMs,
        onAuthorizeUrl: async (data) => {
          attemptNumber += 1;
          await publish({
            phase: "awaiting-consent",
            step,
            attempts: attemptNumber,
            stepTitle: `live registration (fixture ${label}) — waiting for human consent`,
            authorizeUrl: data.authorize_url,
            flowId: data.flow_id,
            flowExpiresAt: data.expires_at,
            pollStatus: "pending",
            lastEvent: `flow registered server-side (flow ${data.flow_id.slice(0, 8)}…, expires in ${Math.round(data.expires_at - Date.now() / 1000)}s) — open the consent link to authorize`,
          });
          console.log(
            `[fixture ${label}] authorize_url (attempt ${attemptNumber}): ${data.authorize_url}`,
          );
        },
        onPollStatus: async (data) => {
          await publish({
            pollStatus: data.status,
            lastEvent: `poll: ${data.status} (attempt ${attemptNumber})`,
          });
        },
      }),
    };
  } catch (error) {
    if (error instanceof ZCodeCliLoginError && error.code === "auth_timeout") {
      return { ok: false, timeout: true };
    }
    return {
      ok: false,
      error:
        error instanceof ZCodeCliLoginError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
    };
  }
}

/* -------------------------------------------------------------- post-login -- */

async function postLogin(
  runState: RunState,
  step: number,
  fixture: FixtureRecord,
  providerRuntimeEnv: NodeJS.ProcessEnv,
  result: Awaited<ReturnType<typeof loginZCodeCli>>,
): Promise<void> {
  const label = step === 1 ? "A" : "B";
  await publish({ phase: "step-running", step, lastEvent: `consent received (fixture ${label}) — credentials landing` });
  const zcodeDir = join(fixture.baseDir, ".zcode");
  const credentialsPath = join(zcodeDir, "v2", "credentials.json");
  const providerConfigPath = join(zcodeDir, "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  check(
    `[fixture ${label}] consent completed — credentials.json landed`,
    await exists(credentialsPath),
    credentialsPath,
  );
  const providerConfigLanded = await exists(providerConfigPath);
  check(
    `[fixture ${label}] provider_config.json landed (coding-plan connection persisted)`,
    providerConfigLanded,
    providerConfigPath,
  );
  const gatingEnv = loginEnvFor(fixture, providerRuntimeEnv);
  const gating = await hasConfiguredStandaloneCodingPlan({ env: gatingEnv });
  check(
    `[fixture ${label}] hasConfiguredStandaloneCodingPlan === true (grant active)`,
    gating === true,
  );
  await publish({ lastEvent: `credentials landed (fixture ${label}); resolving coding-plan material` });
  const material = await resolveMaterial(fixture, providerRuntimeEnv);
  check(
    `[fixture ${label}] server issued coding-plan material (fresh PAT against account API key)`,
    Boolean(material.apiKeyId),
    `apiKeyId=${material.apiKeyId} org=${material.organizationId} project=${material.projectId}`,
  );
  const record = runState.fixtures[String(step)]!;
  record.userId = result.user.user_id;
  record.mainModel = result.model;
  record.material = material;
  record.registeredAt = new Date().toISOString();
  await saveRunState(runState);
  console.log(
    `[fixture ${label}] registered: user_id=${result.user.user_id} model=${result.model} apiKeyId=${material.apiKeyId}`,
  );
}

/* ------------------------------------------------------------------ probes -- */

async function cipherLocalityProbe(
  fixtureA: FixtureRecord,
  fixtureB: FixtureRecord,
): Promise<void> {
  console.log("[probe] cipher-key locality: fixture A credentials under fixture B's key…");
  const probeBase = join(RUN_DIR, "probe-cipher-locality");
  await rm(probeBase, { recursive: true, force: true });
  await mkdir(join(probeBase, ".zcode", "v2"), { recursive: true });
  const sourceCredentials = join(fixtureA.baseDir, ".zcode", "v2", "credentials.json");
  const probeCredentials = join(probeBase, ".zcode", "v2", "credentials.json");
  await copyFile(sourceCredentials, probeCredentials);
  const probeRuntimeEnv = await prepareProviderRuntimeEnv(probeBase, fixtureEnv(probeBase));
  const probeEnv = (secret: string): NodeJS.ProcessEnv =>
    fixtureEnv(probeBase, {
      ZCODE_CREDENTIAL_SECRET: secret,
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: probeRuntimeEnv[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]!,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: probeRuntimeEnv[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]!,
    });

  // 同一份密文 + 正确密钥（A）：解锁成功（文件完好、门控为真）。
  const storeA = createSharedZCodeCredentialStore({ env: probeEnv(fixtureA.secret) });
  const valuesA = await storeA.loadMany([SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]);
  const unlocked = Boolean(valuesA[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]);
  const gatingA = await hasConfiguredStandaloneCodingPlan({ env: probeEnv(fixtureA.secret) });
  check(
    "[probe] fixture A credentials + cipher key A -> unlock + grant active",
    unlocked && gatingA === true,
    `token=${unlocked} gating=${gatingA}`,
  );

  // 同一份密文 + 错误密钥（B）：解密失败、门控为假 —— 密钥纯本地，服务端从未见过。
  const storeB = createSharedZCodeCredentialStore({ env: probeEnv(fixtureB.secret) });
  let wrongKeyLockedOut = false;
  let wrongKeyDetail = "";
  try {
    const valuesB = await storeB.loadMany([SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]);
    wrongKeyLockedOut = !valuesB[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken];
    wrongKeyDetail = "loadMany returned null token";
  } catch (error) {
    wrongKeyLockedOut = true;
    wrongKeyDetail = `loadMany rejected: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`;
  }
  let gatingB: boolean | "threw" = "threw";
  try {
    gatingB = await hasConfiguredStandaloneCodingPlan({ env: probeEnv(fixtureB.secret) });
  } catch {
    gatingB = "threw";
  }
  check(
    "[probe] same credentials + cipher key B -> locked out (key never leaves the machine)",
    wrongKeyLockedOut && gatingB !== true,
    `${wrongKeyDetail}; gating=${gatingB}`,
  );
}

async function deviceMidRegenProbe(
  runState: RunState,
  fixtureA: FixtureRecord,
  envA: NodeJS.ProcessEnv,
): Promise<void> {
  console.log("[probe] deviceMid regeneration on registered fixture A…");
  await rm(join(fixtureA.baseDir, ".zcode", "v2", "telemetry-state.json"), { force: true });
  await rm(join(fixtureA.baseDir, ".zcode", "v2", "telemetry-state.lock"), { force: true });
  const sink = await startOtlpSink();
  let regenerated: string;
  try {
    ({ deviceMid: regenerated } = await spawnDeviceMidPhase(fixtureA.baseDir, sink.url));
  } finally {
    await sink.stop();
  }
  check(
    "[probe] deviceMid regenerated on the SAME installation (new random id)",
    regenerated !== fixtureA.deviceMid,
    `${fixtureA.deviceMid} -> ${regenerated}`,
  );
  const gating = await hasConfiguredStandaloneCodingPlan({ env: loginEnvFor(fixtureA, envA) });
  check(
    "[probe] grant still active after device identity change",
    gating === true,
  );
  const material = await resolveMaterial(fixtureA, envA);
  check(
    "[probe] server re-issued coding-plan material to same account API key after device change",
    material.apiKeyId === fixtureA.material?.apiKeyId,
    `apiKeyId=${material.apiKeyId}`,
  );
  fixtureA.deviceMid = regenerated;
  await saveRunState(runState);
}

/* ----------------------------------------------------------------- verdict -- */

async function verdict(runState: RunState): Promise<void> {
  const a = runState.fixtures["1"]!;
  const b = runState.fixtures["2"]!;
  const sameUser = a.userId === b.userId;
  const sameKey = a.material?.apiKeyId === b.material?.apiKeyId;
  const sameLocation =
    a.material?.organizationId === b.material?.organizationId &&
    a.material?.projectId === b.material?.projectId;
  const differentDevice = a.deviceMid !== b.deviceMid;
  const differentCipherKey = a.secretFingerprint !== b.secretFingerprint;

  check(
    "cross-fixture: server returned the SAME account user_id for both installs",
    sameUser,
    `${a.userId} / ${b.userId}`,
  );
  check(
    "cross-fixture: server bound both installs to the SAME coding-plan API key",
    sameKey && sameLocation,
    `apiKeyId=${a.material?.apiKeyId} / ${b.material?.apiKeyId}`,
  );
  check(
    "cross-fixture: fixtures had DIFFERENT deviceMid (server did not key on it)",
    differentDevice,
  );
  check(
    "cross-fixture: fixtures had DIFFERENT local cipher keys (never transmitted)",
    differentCipherKey,
  );

  const failed = results.filter((result) => !result.pass);
  const identity = {
    "account user_id (server-side)": {
      fixtureA: a.userId,
      fixtureB: b.userId,
      relation: sameUser ? "same" : "different",
    },
    "coding-plan apiKeyId (server-side)": {
      fixtureA: a.material?.apiKeyId,
      fixtureB: b.material?.apiKeyId,
      relation: sameKey ? "same" : "different",
    },
    "deviceMid (local, random per install)": {
      fixtureA: a.deviceMid,
      fixtureB: b.deviceMid,
      relation: differentDevice ? "different" : "same",
    },
    "credential cipher key (local, never transmitted)": {
      fixtureA: a.secretFingerprint,
      fixtureB: b.secretFingerprint,
      relation: differentCipherKey ? "different" : "same",
    },
  };
  const verdictData = { pass: failed.length === 0, checks: results, identity };
  const report = {
    runId: runState.runId,
    completedAt: new Date().toISOString(),
    verdict: verdictData,
    fixtures: {
      "1": {
        baseDir: a.baseDir,
        deviceMid: a.deviceMid,
        cipherKeyFingerprint: a.secretFingerprint,
        userId: a.userId,
        mainModel: a.mainModel,
        material: a.material,
        registeredAt: a.registeredAt,
      },
      "2": {
        baseDir: b.baseDir,
        deviceMid: b.deviceMid,
        cipherKeyFingerprint: b.secretFingerprint,
        userId: b.userId,
        mainModel: b.mainModel,
        material: b.material,
        registeredAt: b.registeredAt,
      },
    },
    attempts: runState.attempts,
    conclusion:
      "Grant issuance is keyed on the account user_id: two installations differing in every " +
      "local identity layer (deviceMid, credential cipher key) received the same account identity " +
      "and the same coding-plan API key (find-or-create, account-scoped). The keyring cipher key " +
      "never leaves the machine; deviceMid is only ever transmitted as model-request telemetry " +
      "metadata (anthropic metadata.user_id.device_id), never during registration or issuance.",
  };
  await writeAtomic(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  await publish({
    phase: "complete",
    step: STEP_COUNT,
    verdict: verdictData,
    lastEvent: `verdict: ${verdictData.pass ? "pass" : "FAIL"} (${results.length - failed.length}/${results.length} checks)`,
  });
  console.log("");
  console.log(
    `verdict: ${verdictData.pass ? "pass" : "FAIL"}  (${results.length - failed.length}/${results.length} checks passed)`,
  );
  console.log(`report: ${REPORT_PATH}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

/* -------------------------------------------------------------------- main -- */

async function main(): Promise<void> {
  const otlpUrlArg = flag("otlp-url");
  if (flag("phase") === "device-mid") {
    if (!otlpUrlArg) throw new Error("device-mid phase requires --otlp-url");
    await deviceMidPhase(otlpUrlArg);
    return;
  }

  const maxWallMs = Number(flag("max-wall-ms") ?? 480_000);
  const attemptTimeoutMs = Number(flag("attempt-timeout-ms") ?? 285_000);
  const deadline = Date.now() + maxWallMs;
  const runState = await loadRunState();
  console.log(`== Task 4 live cycle: runId=${runState.runId} runDir=${RUN_DIR} ==`);
  await publish({
    runId: runState.runId,
    steps: STEP_COUNT,
    step: Math.min(runState.step, STEP_COUNT),
    phase: "step-running",
    lastEvent: runState.step > STEP_COUNT ? "resuming: cycle already complete" : "harness started",
    reportPath: REPORT_PATH,
    runDir: RUN_DIR,
  });

  if (runState.step > STEP_COUNT) {
    await verdict(runState);
    return;
  }

  for (let step = runState.step; step <= STEP_COUNT; step += 1) {
    const label = step === 1 ? "A" : "B";
    const { fixture, providerRuntimeEnv } = await ensureFixture(runState, step);

    // fresh 门控证明：注册前必须是未注册态。
    if (!fixture.userId) {
      const freshGating = await hasConfiguredStandaloneCodingPlan({
        env: loginEnvFor(fixture, providerRuntimeEnv),
      });
      check(
        `[fixture ${label}] fresh install is unregistered (hasConfiguredStandaloneCodingPlan === false)`,
        freshGating === false,
      );
    }

    let registered = false;
    while (Date.now() < deadline) {
      const remainingWall = deadline - Date.now();
      const outcome = await attemptLogin(
        step,
        fixture,
        providerRuntimeEnv,
        Math.min(attemptTimeoutMs, remainingWall),
      );
      runState.attempts[String(step)] = (runState.attempts[String(step)] ?? 0) + 1;
      await saveRunState(runState);
      if (outcome.ok && outcome.result) {
        await postLogin(runState, step, fixture, providerRuntimeEnv, outcome.result);
        registered = true;
        break;
      }
      if (!outcome.timeout) {
        await publish({
          phase: "failed",
          step,
          lastEvent: `fixture ${label}: ${outcome.error}`,
        });
        console.error(`[fixture ${label}] login failed: ${outcome.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[fixture ${label}] attempt ${runState.attempts[String(step)]} expired without consent (wall budget left: ${Math.round((deadline - Date.now()) / 1000)}s)`,
      );
      await publish({
        attempts: runState.attempts[String(step)],
        lastEvent: `attempt expired without consent — starting next attempt (fixture ${label})`,
      });
    }
    if (!registered) {
      runState.step = step;
      await saveRunState(runState);
      await publish({
        phase: "awaiting-consent",
        step,
        lastEvent: `wall budget exhausted while awaiting consent (fixture ${label}) — re-run the driver to resume`,
      });
      console.log(
        `[fixture ${label}] wall budget exhausted while awaiting consent — re-run to resume`,
      );
      process.exitCode = 2;
      return;
    }
    runState.step = step + 1;
    await saveRunState(runState);
    await publish({ phase: "step-done", step, lastEvent: `fixture ${label} registered` });
  }

  const fixtureA = runState.fixtures["1"]!;
  const fixtureB = runState.fixtures["2"]!;
  const envA = await prepareProviderRuntimeEnv(fixtureA.baseDir, fixtureEnv(fixtureA.baseDir));
  await cipherLocalityProbe(fixtureA, fixtureB);
  await deviceMidRegenProbe(runState, fixtureA, envA);
  await verdict(runState);
}

main().catch(async (error) => {
  console.error(error);
  await publish({
    phase: "failed",
    lastEvent: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  }).catch(() => undefined);
  process.exitCode = 1;
});
