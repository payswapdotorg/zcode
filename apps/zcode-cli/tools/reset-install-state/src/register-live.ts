#!/usr/bin/env node
/* Task 4 两阶段 live-registration 驱动（审计 §7.1）——真人授权最后一公里。
   spec: apps/zcode-cli/docs/design/v2/install-identity-lifecycle.md §3.1 / §7.1

   verify-fresh-registration.ts 的阶段 4 是无真人的 smoke（init + live pending + auth_timeout 预期、
   零落盘）；loginZCodeCli 本身不可续（每次都重新 init，auth-login.ts:84-98），但 adapter 层的
   createCliOAuthClient().poll({flowId, pollToken}) 是公开导出且 wire 兼容——两个独立进程夹一段
   离线的人类浏览器授权即可复现完整 grant 签发：

     phase1  reset --apply + 生产 init → 打印 authorize_url 后立即退出（不轮询），
             state.json（0600）保存 poll_token / flow_id / credential_secret / base_dir；
     （人：用已登录 z.ai 账号的浏览器打开 authorize_url 完成授权）
     phase2  仅凭 state.json 复跑：同一 fixture env（同一 ZCODE_CREDENTIAL_SECRET，解密跨阶段一致）
             → 复轮询同一 flow → ready → 复刻 loginZCodeCli 的落盘尾（saveZaiLoginCredentials +
               account-provider:*:identity/auth-source + 默认模型 provider_config.json）
             → 断言 → grant 探针（信息性、永不致命，只打印指纹）→ {verdict,...} JSON。

   用法：
     tsx src/register-live.ts phase1 [--state-file=PATH] [--base-dir=DIR]
     tsx src/register-live.ts phase2 --state-file=PATH [--poll-deadline-ms=N]
   缺省 state：<repo>/tools/reset-install-state/runs/live-flow/state.json；
   缺省 base：state 文件同目录的 base/。
   退出码：0 成功（含 already-registered）；2 用法/state 校验失败；3 poll failed；
           4 flow 过期（信封 3004/等价）；1 其余失败。

   安全约定：任何输出不得出现 poll_token / credential_secret / token 值——探针只打印长度与指纹。 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import {
  CliOAuthError,
  createCliOAuthClient,
  createCliOAuthPollToken,
  createCodingPlanApiKeyResolver,
  createNodeHttpClientAdapter,
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type CliOAuthPollData,
  type CliOAuthReadyData,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { hasConfiguredStandaloneCodingPlan } from "@zcode/bootstrap";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  NodeZCodeBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveZCodeBuiltinCachePaths,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import {
  buildZCodeEndpointUrls,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
} from "@zcode/shared";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(TOOL_DIR, "..", "reset-install-state.sh");
const REPO_ROOT = join(TOOL_DIR, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
/** 缺省 state 文件：<repo>/tools/reset-install-state/runs/live-flow/state.json。 */
const DEFAULT_STATE_FILE = join(TOOL_DIR, "..", "runs", "live-flow", "state.json");
const STATE_VERSION = 1;
/** 与 auth-login-polling.ts MIN_POLL_INTERVAL_MS 一致。 */
const POLL_MIN_INTERVAL_MS = 1_000;
/** phase2 缺省截止：expires_at_unix − 30s，且不超过 20 min。 */
const DEADLINE_MARGIN_MS = 30_000;
const DEFAULT_DEADLINE_CAP_MS = 20 * 60_000;
const POLL_REQUEST_TIMEOUT_MS = 15_000;

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

interface FlowState {
  version: number;
  phase: "init";
  provider: "zai";
  base_dir: string;
  credential_secret: string;
  poll_token: string;
  flow_id: string;
  authorize_url: string;
  expires_at_unix: number;
  poll_interval_sec: number;
  created_at_iso: string;
}

const STATE_FIELDS: ReadonlyArray<{ key: keyof FlowState; kind: "string" | "number" }> = [
  { key: "version", kind: "number" },
  { key: "phase", kind: "string" },
  { key: "provider", kind: "string" },
  { key: "base_dir", kind: "string" },
  { key: "credential_secret", kind: "string" },
  { key: "poll_token", kind: "string" },
  { key: "flow_id", kind: "string" },
  { key: "authorize_url", kind: "string" },
  { key: "expires_at_unix", kind: "number" },
  { key: "poll_interval_sec", kind: "number" },
  { key: "created_at_iso", kind: "string" },
];

/* ------------------------------------------------------------------ args --- */

function flagValue(args: readonly string[], name: string): string | undefined {
  const hit = args.find((candidate) => candidate.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

function usage(): never {
  console.error(
    [
      "usage: tsx src/register-live.ts phase1 [--state-file=PATH] [--base-dir=DIR]",
      "       tsx src/register-live.ts phase2 --state-file=PATH [--poll-deadline-ms=N]",
      "",
      "phase1: reset-install-state.sh --apply + production OAuth init; prints authorize_url",
      "        and exits immediately (no polling). Human approves in the browser afterwards.",
      "phase2: resumes the same flow from the state file (same ZCODE_CREDENTIAL_SECRET),",
      "        persists credentials on ready, asserts grant state, runs a non-fatal grant probe.",
      "",
      "exit codes: 0 ok (incl. already-registered); 2 usage/state validation; 3 poll failed;",
      "            4 flow expired (rerun phase1); 1 other failure.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const candidate of args) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/u.exec(candidate);
    if (!match || !allowed.includes(match[1]!)) usage();
    parsed[match[1]!] = match[2]!;
  }
  return parsed;
}

/* ---------------------------------------------------------- env plumbing --- */
/* 与 verify-fresh-registration.ts 同构：双 env 轴成对注入（审计 §2.3）+ 产品路径的
   provider runtime env（随包基线 → 首启动物化 active 缓存）。 */

function fixtureEnv(baseDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ZCODE_DATA_BASE_DIR: baseDir,
    ZCODE_HOME: join(baseDir, ".zcode"),
    HOME: baseDir,
    ...extra,
  };
}

/** 与 CLI 入口 prepareCliProviderRuntimeEnv 同构（产品路径）。 */
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
    bundledFilePath: join(REPO_ROOT, "config", "provider", "zcode-builtin.json"),
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

/** 与 auth-login.ts createDefaultHttpClient / verify-live-cycle.ts createResolver 同构。 */
function createHttpClient(env: NodeJS.ProcessEnv) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

async function runReset(baseDir: string): Promise<void> {
  // 脚本拒绝不存在的 --base-dir（`cd` 失败即 die_fs）；先建目录再 apply。
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

/* --------------------------------------------------- local replicas（引用） - */

/* 与 packages/bootstrap/src/app/standalone-account-provider-runtime.ts:88-96 完全同构。
   该模块（及其 key 帮助函数）不是 @zcode/bootstrap 的公开导出（index.ts 未 re-export），
   按任务约束本地复刻、不改库文件。注意 persistStandaloneCodingPlanConnection
   （auth-login.ts:319-330）用的是 catalog 解析出的 Provider ID（account:zai-individual-coding-plan），
   不是 family（"zai"）——键名必须与运行时一致，否则 hasStandaloneCodingPlanAccess 读不到身份。 */
function standaloneAccountIdentityCredentialKey(providerId: string): string {
  return `account-provider:${providerId.trim()}:identity`;
}

function standaloneAccountAuthSourceCredentialKey(providerId: string): string {
  return `account-provider:${providerId}:auth-source`;
}

interface BuiltinSnapshot {
  readonly providers: {
    entries(): ReadonlyArray<readonly [string, ProviderConfigView]>;
  };
}

interface ProviderConfigView {
  readonly access?:
    | { readonly type: "api-key" | "zhipu-coding-plan-api-key" }
    | { readonly type: "zhipu-account"; readonly accountType?: string; readonly mode?: string }
    | null;
  readonly builtinModelIds?: readonly string[];
}

/* 与 resolveStandaloneCodingPlanProvider（standalone-account-provider-runtime.ts:73-86）+
   readStandaloneCodingPlanCatalog 的筛选（同文件 46-55）同构：access.type=zhipu-account 且
   mode=individual-coding-plan 且 accountType=<family>，取第一个非空 builtinModelIds 条目。
   非公开导出，本地复刻；快照经公开导出的 NodeZCodeBuiltinProviderConfigSource 读取（与
   readStandaloneCodingPlanCatalog:57-70 的取法一致：env 变量值直接作为 bundledFilePath）。 */
function resolveIndividualCodingPlanProvider(
  snapshot: BuiltinSnapshot,
  family: "zai" | "bigmodel",
): { providerId: string; modelId: string } {
  const matches = snapshot.providers.entries().flatMap(([providerId, provider]) => {
    const access = provider.access;
    const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
    return access?.type === "zhipu-account" &&
      access.mode === "individual-coding-plan" &&
      access.accountType === family &&
      modelId
      ? [{ modelId, providerId }]
      : [];
  });
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config 必须为 ${family} 声明唯一 Individual Coding Plan Provider（找到 ${matches.length} 个）`,
    );
  }
  return matches[0]!;
}

async function readBuiltinSnapshot(env: NodeJS.ProcessEnv): Promise<BuiltinSnapshot> {
  const filePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    // 与 standalone-account-provider-runtime.ts:57-59 同一约束。
    throw new Error(`${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: filePath, watch: false });
  try {
    return (await source.read()) as unknown as BuiltinSnapshot;
  } finally {
    source.dispose();
  }
}

/* ------------------------------------------------------------------ phase1 - */

async function phase1(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args, ["state-file", "base-dir"]);
  const stateFile = parsed["state-file"] ?? DEFAULT_STATE_FILE;
  const baseDir = parsed["base-dir"] ?? join(dirname(stateFile), "base");

  console.log("== register-live phase1: fresh reset + OAuth init (production https://zcode.z.ai) ==");

  // (a) true fresh state：整棵 .zcode 清掉（dry-run 不接受——必须 --apply）。
  await runReset(baseDir);

  // (b) fixture env：双 env 轴成对注入 + 全新随机 ZCODE_CREDENTIAL_SECRET（headless 干净
  //     keychain 等价，审计 §4）；secret 进 state，phase2 必须复用同一 secret 否则解密失败。
  const credentialSecret = randomBytes(32).toString("base64url");
  const providerRuntimeEnv = await prepareProviderRuntimeEnv(baseDir, fixtureEnv(baseDir));
  const loginEnv = fixtureEnv(baseDir, {
    ZCODE_CREDENTIAL_SECRET: credentialSecret,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]!,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]!,
  });

  // (c) pollToken：32B 随机 hex（cli-oauth.ts:123-125）。init 不发送任何设备身份（§3.1）。
  const pollToken = createCliOAuthPollToken();

  // (d) 生产 init：不传 baseUrl → DEFAULT_ZCODE_OAUTH_BASE_URL = https://zcode.z.ai/api/v1
  //     （cli-oauth.ts:4,75-99）。任何 endpoint env 覆盖来自外部环境，驱动自身不覆盖。
  const oauthClient = createCliOAuthClient({
    providerId: "zai",
    httpClient: createHttpClient(loginEnv),
  });
  const initData = await oauthClient.init({ pollToken });

  // (e) state 落盘（0600）：内容含 poll_token + credential_secret——这正是它的用途，永不打印。
  const state: FlowState = {
    version: STATE_VERSION,
    phase: "init",
    provider: "zai",
    base_dir: baseDir,
    credential_secret: credentialSecret,
    poll_token: pollToken,
    flow_id: initData.flow_id,
    authorize_url: initData.authorize_url,
    expires_at_unix: initData.expires_at,
    poll_interval_sec: initData.poll_interval_sec,
    created_at_iso: new Date().toISOString(),
  };
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(stateFile, 0o600);

  // (f) 输出 + 立即退出（不轮询——进程退出让人可以安心点授权页）。
  const expiresAtIso = new Date(initData.expires_at * 1_000).toISOString();
  const minutesLeft = Math.max(0, Math.round((initData.expires_at * 1_000 - Date.now()) / 60_000));
  console.log("");
  console.log(`authorize_url: ${initData.authorize_url}`);
  console.log(`flow_id: ${initData.flow_id}`);
  console.log(`expires_at: ${initData.expires_at} (${expiresAtIso}, ~${minutesLeft} min remaining)`);
  console.log(`poll_interval_sec: ${initData.poll_interval_sec}`);
  console.log(`base_dir: ${baseDir}`);
  console.log(`state_file: ${stateFile} (mode 0600; contains poll_token + credential_secret — never print)`);
  console.log("");
  console.log("human step: open authorize_url above in a browser logged into the z.ai account and approve;");
  console.log(`then run: ${TSX} ${join(TOOL_DIR, "register-live.ts")} phase2 --state-file=${stateFile}`);
  process.exitCode = 0;
}

/* ------------------------------------------------------------------ phase2 - */

function exitFlowExpired(): never {
  console.error("flow expired — re-run phase1 and click the new URL");
  process.exit(4);
}

async function loadAndValidateState(stateFile: string): Promise<FlowState> {
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch (error) {
    console.error(
      `register-live phase2: cannot read state file: ${stateFile} (${
        error instanceof Error ? error.message : String(error)
      }) — run phase1 first`,
    );
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`register-live phase2: state file is not valid JSON: ${stateFile}`);
    process.exit(2);
  }
  const state = parsed as Partial<FlowState>;
  const missing = STATE_FIELDS.filter(({ key, kind }) => {
    const value = state[key];
    return kind === "number" ? typeof value !== "number" || !Number.isFinite(value) : typeof value !== "string" || !value.trim();
  }).map(({ key }) => key);
  if (missing.length > 0) {
    console.error(`register-live phase2: state file incomplete, missing/invalid fields: ${missing.join(", ")}`);
    process.exit(2);
  }
  if (state.version !== STATE_VERSION) {
    console.error(`register-live phase2: unsupported state version ${String(state.version)} (expected ${STATE_VERSION})`);
    process.exit(2);
  }
  if (state.phase !== "init" || state.provider !== "zai") {
    console.error(`register-live phase2: unexpected state phase/provider: ${String(state.phase)}/${String(state.provider)}`);
    process.exit(2);
  }
  return state as FlowState;
}

/**
 * 复刻 loginZCodeCli 的落盘尾（auth-login.ts:121-206 + persistStandaloneCodingPlanConnection
 * auth-login.ts:309-355）：saveZaiLoginCredentials → identity/auth-source → saveConfiguredDefault。
 * 私有尾不可直接调用，按任务约束以公开导出逐字复刻（差异：无 recovery guard / abort 信号，
 * 单进程单写者；legacy personal-config importer 非公开导出，fresh base 上无 legacy 文件可导入，
 * 省略 importLegacy —— NodePersonalProviderConfigRepository 的可选项）。
 */
async function persistLoginTail(
  ready: CliOAuthReadyData,
  loginEnv: NodeJS.ProcessEnv,
): Promise<{ providerId: string; modelId: string; credentialsPath: string; personalPath: string }> {
  const store = createSharedZCodeCredentialStore({ env: loginEnv });
  // ① 凭据整组写入（auth-login.ts:143-153 → shared-credentials.ts saveZaiLoginCredentials:361-376）。
  await store.saveZaiLoginCredentials({
    accessToken: ready.accessToken,
    jwtToken: ready.token,
    user: ready.user,
  });
  // ② 连接身份：zai 家族 = user.user_id（auth-login.ts:134-141），auth-source = "oauth"
  //    （persistStandaloneCodingPlanConnection:326-330，键 = catalog 解析出的 Provider ID）。
  const snapshot = await readBuiltinSnapshot(loginEnv);
  const configured = resolveIndividualCodingPlanProvider(snapshot, "zai");
  await store.saveMany({
    [standaloneAccountIdentityCredentialKey(configured.providerId)]: ready.user.user_id,
    [standaloneAccountAuthSourceCredentialKey(configured.providerId)]: "oauth",
  });
  // ③ 默认模型（persistStandaloneCodingPlanConnection:331-350）：
  //    NodePersonalProviderConfigRepository + NodeModelSelectionConfigRepository.saveConfiguredDefault。
  const personalPath =
    loginEnv[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ||
    join(dirname(store.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: personalPath,
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    await repository.saveConfiguredDefault({ providerId: configured.providerId, modelId: configured.modelId });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    providerId: configured.providerId,
    modelId: configured.modelId,
    credentialsPath: store.filePath,
    personalPath,
  };
}

/** grant 探针（信息性、永不致命）：resolveMaterial 链路 = POST api.z.ai/api/auth/z/login →
 *  getCustomerInfo → api_keys → access_tokens（coding-plan-api-key.ts:130-189）。只打印指纹。 */
async function grantProbe(
  loginEnv: NodeJS.ProcessEnv,
): Promise<{ outcome: "ok" | "warn" | "skipped"; details: string[] }> {
  const details: string[] = [];
  const store = createSharedZCodeCredentialStore({ env: loginEnv });
  const accessToken = await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken);
  if (!accessToken) {
    details.push("skipped: zai access token missing from credential store");
    return { outcome: "skipped", details };
  }
  try {
    const resolver = createCodingPlanApiKeyResolver({ httpClient: createHttpClient(loginEnv) });
    const material = await resolver.resolveMaterial({ accessToken, family: "zai" });
    const fingerprint = createHash("sha256").update(material.token).digest("hex").slice(0, 12);
    details.push(`apiKeyId=${material.apiKeyId} org=${material.organizationId} project=${material.projectId}`);
    details.push(`token length=${material.token.length} fingerprint=sha256:${fingerprint}…(value never printed)`);
    return { outcome: "ok", details };
  } catch (error) {
    details.push(
      `WARN ${error instanceof Error ? error.name : "unknown"}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
    return { outcome: "warn", details };
  }
}

/** billing/balance 探针（可选、信息性）：GET {origin}/api/v1/zcode-plan/billing/balance，
 *  Authorization: Bearer <zcodejwttoken> + X-Device-Mid（必填，docs/zai-start-plan-provider.md:65）。 */
async function billingBalanceProbe(
  baseDir: string,
  loginEnv: NodeJS.ProcessEnv,
): Promise<{ outcome: "ok" | "warn" | "skipped"; details: string[] }> {
  const details: string[] = [];
  const deviceMid = await readTelemetryDeviceMid(baseDir);
  if (!deviceMid) {
    details.push("skipped: telemetry-state.json has no deviceMid yet on this fresh install (X-Device-Mid is required by the endpoint)");
    return { outcome: "skipped", details };
  }
  try {
    const store = createSharedZCodeCredentialStore({ env: loginEnv });
    const jwt = await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken);
    if (!jwt) throw new Error("zcodejwttoken missing from credential store");
    const url = `${buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(loginEnv)).zcodePlanBillingBalanceUrl}?app_version=${ZCODE_VERSION}`;
    const response = await createHttpClient(loginEnv).request({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}`, "X-Device-Mid": deviceMid },
      maxResponseBytes: 64 * 1024,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    details.push(`HTTP ${response.status} (${response.status >= 200 && response.status < 300 ? "balance readable" : "non-2xx"})`);
    return { outcome: response.status >= 200 && response.status < 300 ? "ok" : "warn", details };
  } catch (error) {
    details.push(`WARN ${error instanceof Error ? error.name : "unknown"}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return { outcome: "warn", details };
  }
}

async function readTelemetryDeviceMid(baseDir: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(baseDir, ".zcode", "v2", "telemetry-state.json"), "utf8"),
    ) as { deviceMid?: unknown };
    return typeof parsed.deviceMid === "string" && parsed.deviceMid.trim() ? parsed.deviceMid.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function phase2(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args, ["state-file", "poll-deadline-ms"]);
  const stateFile = parsed["state-file"];
  if (!stateFile) usage();
  const state = await loadAndValidateState(stateFile);

  console.log("== register-live phase2: resume flow + persist + assert ==");
  const baseDir = state.base_dir;

  // (b) 同一 fixture env：同一 base_dir、同一 credential_secret（解密跨阶段一致的唯一钥匙，审计 §4）。
  const providerRuntimeEnv = await prepareProviderRuntimeEnv(baseDir, fixtureEnv(baseDir));
  const loginEnv = fixtureEnv(baseDir, {
    ZCODE_CREDENTIAL_SECRET: state.credential_secret,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]!,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: providerRuntimeEnv[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]!,
  });
  const credentialsPath = join(baseDir, ".zcode", "v2", "credentials.json");
  const store = createSharedZCodeCredentialStore({ env: loginEnv });

  // 幂等入口：已注册（credentials 存在且 plan 门控为真）→ 不重放，直接成功退出。
  const preGating = await hasConfiguredStandaloneCodingPlan({ env: loginEnv });
  if (existsSync(credentialsPath) && preGating === true) {
    console.log("already-registered (credentials.json exists + plan gating true) — nothing to do");
    console.log(
      JSON.stringify({
        verdict: "already-registered",
        has_plan: true,
        grant_probe: "skipped",
        details: { credentials: credentialsPath },
      }),
    );
    process.exitCode = 0;
    return;
  }

  // (c) fresh 门控预断言：注册前必须是未注册态。
  check("pre-registration gating: hasConfiguredStandaloneCodingPlan === false", preGating === false);
  if (preGating !== false) {
    console.error("register-live phase2: fresh gating violated (plan configured without credentials) — aborting");
    process.exitCode = 1;
    return;
  }

  // 截止：缺省 = expires_at_unix − 30s，且不超过 20 min；--poll-deadline-ms 显式覆盖。
  const startedMs = Date.now();
  const explicitDeadlineMs = Number(parsed["poll-deadline-ms"]);
  const deadlineMs =
    Number.isFinite(explicitDeadlineMs) && explicitDeadlineMs > 0
      ? startedMs + explicitDeadlineMs
      : Math.min(state.expires_at_unix * 1_000 - DEADLINE_MARGIN_MS, startedMs + DEFAULT_DEADLINE_CAP_MS);
  if (Date.now() >= deadlineMs) exitFlowExpired();

  // (d) 复轮询同一 flow（adapter 客户端公开导出；loginZCodeCli 本身不可续）。
  const oauthClient = createCliOAuthClient({
    providerId: state.provider,
    httpClient: createHttpClient(loginEnv),
  });
  const pollIntervalMs = Math.max(POLL_MIN_INTERVAL_MS, state.poll_interval_sec * 1_000);
  let ready: CliOAuthReadyData | undefined;
  while (Date.now() < deadlineMs) {
    let data: CliOAuthPollData;
    try {
      data = await oauthClient.poll({ flowId: state.flow_id, pollToken: state.poll_token });
    } catch (error) {
      if (error instanceof CliOAuthError && error.businessCode === 3004) exitFlowExpired();
      // 与 pollUntilReady（auth-login-polling.ts:41-49）一致：408/429/5xx 与非 CliOAuthError
      // （网络/超时）按服务端间隔重试；其余业务错误直接上抛。
      if (
        error instanceof CliOAuthError &&
        !(error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)
      )
        throw error;
      console.log(
        `    poll transient error (${error instanceof Error ? error.name : "unknown"}) — retry in ${Math.round(pollIntervalMs / 1000)}s`,
      );
      await delay(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
      continue;
    }
    if (data.status === "ready") {
      ready = data;
      break;
    }
    if (data.status === "failed") {
      console.error("register-live phase2: poll status failed — authorization rejected/expired server-side");
      process.exit(3);
    }
    console.log(`    poll: pending … (${Math.max(0, Math.round((deadlineMs - Date.now()) / 1000))}s to deadline)`);
    await delay(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  }
  if (!ready) exitFlowExpired();
  console.log(`    poll: ready (user_id=${ready.user.user_id})`);

  // (e) 落盘尾。
  const persisted = await persistLoginTail(ready, loginEnv);
  console.log(`    default model: ${persisted.providerId}/${persisted.modelId}`);
  console.log(`    credentials: ${persisted.credentialsPath}`);
  console.log(`    provider_config: ${persisted.personalPath}`);

  // (f) 断言（PASS/FAIL 同 verify 风格）。
  check("credentials.json landed under base", existsSync(persisted.credentialsPath), persisted.credentialsPath);
  const hasPlan = await hasConfiguredStandaloneCodingPlan({ env: loginEnv });
  check("hasConfiguredStandaloneCodingPlan === true (grant active)", hasPlan === true);
  const identityKey = standaloneAccountIdentityCredentialKey(persisted.providerId);
  const identityReadback = await store.load(identityKey);
  check("identity readback === ready.user.user_id", identityReadback === ready.user.user_id, `key=${identityKey}`);
  const authSourceReadback = await store.load(standaloneAccountAuthSourceCredentialKey(persisted.providerId));
  check("auth-source readback === oauth", authSourceReadback === "oauth");

  // (g) grant 探针（信息性、永不致命）。
  const grant = await grantProbe(loginEnv);
  for (const line of grant.details) console.log(`    [grant-probe] ${line}`);
  const billing = await billingBalanceProbe(baseDir, loginEnv);
  for (const line of billing.details) console.log(`    [billing-probe] ${line}`);

  // (h) 结论 JSON（不含任何 secret）+ 退出码。
  const failed = results.filter((result) => !result.pass);
  const verdict = failed.length === 0 ? "pass" : "FAIL";
  console.log("");
  console.log(
    JSON.stringify({
      verdict,
      user_id: ready.user.user_id,
      identity_saved: identityReadback === ready.user.user_id,
      has_plan: hasPlan === true,
      grant_probe: grant.outcome,
      details: {
        checks: results,
        grant: grant.details,
        billing: billing.details,
        main_model: `${persisted.providerId}/${persisted.modelId}`,
        flow_id: state.flow_id,
        state_file: stateFile,
      },
    }),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------- main -- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command !== "phase1" && command !== "phase2") usage();
  if (command === "phase1") await phase1(args.slice(1));
  else await phase2(args.slice(1));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  process.exitCode = 1;
});
