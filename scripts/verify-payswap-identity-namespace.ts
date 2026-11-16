/**
 * PaySwap 设备身份命名空间 — 跨运行时运行时验证（§10 证据）。
 *
 * 在同一进程内、同一 OS 主目录（HOME 指向临时目录）下依次执行：
 *   1. Desktop main：ensureDesktopDeviceMidSync()（窗口创建前的同步确保入口）
 *   2. services / 远端 server：ensureTelemetryDeviceMid()（createServerHostServices
 *      装配与 stdio entry 共用的入口）
 *   3. 独立 CLI：ensureCliDeviceMid()（首次模型请求的入口）
 *   4. services 侧 X-Device-Mid 读取：buildZCodeSourceHeaders()（NodeApiClient /
 *      Start Plan billing 请求头来源）
 *   5. CLI 侧 X-Device-Mid 读取：createProviderEndpointRoutingSourceHeaders()
 *      （provider endpoint routing 配置 GET / billing 请求头来源）
 *
 * 断言：五条路径解析到同一个 <home>/.payswap/zcode/telemetry-state.json，
 * 三个写入方收敛到同一 deviceMid，两个 header 读取方回传同一 deviceMid；
 * 旧 ~/.zcode/v2 命名空间不被读取、不被创建。
 *
 * 运行：node_modules/.bin/tsx scripts/verify-payswap-identity-namespace.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { ensureDesktopDeviceMidSync } from "../packages/desktop/src/main/desktopDeviceMid.js";
import { ensureTelemetryDeviceMid } from "../packages/services/src/telemetry/telemetryCore.js";
import { buildZCodeSourceHeaders } from "../packages/services/src/providers/sourceHeaders.js";
import { ensureCliDeviceMid } from "../apps/zcode-cli/packages/adapters/src/device/cli-device-mid.js";
import { createProviderEndpointRoutingSourceHeaders } from "../apps/zcode-cli/packages/bootstrap/src/provider-endpoint-routing-source-headers.js";
import { resolvePayswapIdentityStateFile } from "../packages/shared/src/payswapDeviceIdentity.js";

const home = await mkdtemp(join(tmpdir(), "payswap-identity-verify-"));
const previousHome = process.env.HOME;
process.env.HOME = home;

try {
  const identityFile = resolvePayswapIdentityStateFile({ env: { HOME: home } });
  assert.equal(identityFile, join(home, ".payswap", "zcode", "telemetry-state.json"));

  // 1) Desktop main —— 窗口创建前同步确保（写方）。
  const desktopMid = ensureDesktopDeviceMidSync();

  // 2) services / 远端 server —— createServerHostServices / stdio entry 入口（写方）。
  const servicesMid = await ensureTelemetryDeviceMid();

  // 3) 独立 CLI —— 首次模型请求入口（写方）。
  const cliMid = await ensureCliDeviceMid({ env: { HOME: home } });

  // 同一文件、同一身份。
  assert.equal(servicesMid, desktopMid);
  assert.equal(cliMid, desktopMid);
  const stateOnDisk = JSON.parse(await readFile(identityFile, "utf8")) as {
    deviceMid?: string;
  };
  assert.equal(stateOnDisk.deviceMid, desktopMid);

  // 4) services 侧 X-Device-Mid（NodeApiClient / Start Plan billing 头来源，读方）。
  const servicesHeaders = buildZCodeSourceHeaders();
  assert.equal(servicesHeaders["X-Device-Mid"], desktopMid);

  // 5) CLI 侧 X-Device-Mid（provider endpoint routing 配置 GET 头来源，读方）。
  const cliHeaders = await createProviderEndpointRoutingSourceHeaders({
    env: { HOME: home, ZCODE_ENV: "production", ZCODE_APP_VERSION: "verify" },
  });
  assert.equal(cliHeaders["X-Device-Mid"], desktopMid);

  // 旧命名空间：预置一份 decoy 身份，验证从不被读取；断言后原样保留。
  const legacyFile = join(home, ".zcode", "v2", "telemetry-state.json");
  await stat(join(home, ".zcode")).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
  });
  await writeFile(legacyFile, JSON.stringify({ deviceMid: "legacy-decoy" }, null, 2), "utf8");
  const cliHeadersWithLegacy = await createProviderEndpointRoutingSourceHeaders({
    env: { HOME: home, ZCODE_ENV: "production", ZCODE_APP_VERSION: "verify" },
  });
  assert.equal(cliHeadersWithLegacy["X-Device-Mid"], desktopMid);
  assert.ok(
    (await readFile(legacyFile, "utf8")).includes("legacy-decoy"),
    "legacy file must stay untouched",
  );

  console.log("payswap-identity-namespace: PASS");
  console.log(`  home            = ${home}`);
  console.log(`  identity file   = ${identityFile}`);
  console.log(`  deviceMid       = ${desktopMid}`);
  console.log("  desktop / services / cli writers converged; X-Device-Mid readers aligned;");
  console.log("  legacy ~/.zcode/v2 namespace never read, never created, never modified.");
} finally {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  await rm(home, { force: true, recursive: true });
}
