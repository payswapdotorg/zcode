// PaySwap 设备身份命名空间的路径规则回归（fork 专属）。
// App 业务单测已退役（docs/testing/unit-test-quality.md）；本文件沿用
// agent-crash-diagnostic.node.test.ts 的例外形态：node:test 定向取样、不进工程 Vitest
// 清单与 pre-push，经包脚本按路径显式执行。
// pnpm --filter @zcode/shared test:payswap-identity
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  PAYSWAP_ZCODE_IDENTITY_DIR_SEGMENTS,
  PAYSWAP_ZCODE_TELEMETRY_LOCK_FILE_NAME,
  PAYSWAP_ZCODE_TELEMETRY_STATE_FILE_NAME,
  resolvePayswapIdentityDir,
  resolvePayswapIdentityLockFile,
  resolvePayswapIdentityStateFile,
} from "../src/payswapDeviceIdentity.js";

/* Desktop / services / 远端 server / CLI 全部经由这些导出解析设备身份文件：
   <home>/.payswap/zcode/telemetry-state.json（+ 同目录 .lock）。本文件锚定规则本身。 */
describe("PaySwap device identity path resolution", () => {
  test("resolves the canonical namespace under the OS home directory by default", () => {
    assert.equal(resolvePayswapIdentityDir(), join(homedir(), ".payswap", "zcode"));
    assert.equal(
      resolvePayswapIdentityStateFile(),
      join(homedir(), ".payswap", "zcode", "telemetry-state.json"),
    );
    assert.equal(
      resolvePayswapIdentityLockFile(),
      join(homedir(), ".payswap", "zcode", "telemetry-state.lock"),
    );
  });

  test("places the lock file in the same directory as the state file", () => {
    const stateFile = resolvePayswapIdentityStateFile({ homeDir: "/identity-home" });
    const lockFile = resolvePayswapIdentityLockFile({ homeDir: "/identity-home" });
    assert.equal(lockFile, join(stateFile, "..", "telemetry-state.lock"));
    assert.notEqual(lockFile, stateFile);
  });

  test("honors HOME from the provided env record", () => {
    assert.equal(
      resolvePayswapIdentityStateFile({ env: { HOME: "/opt/test-home" } }),
      "/opt/test-home/.payswap/zcode/telemetry-state.json",
    );
  });

  test("falls back to USERPROFILE when HOME is absent (Windows-style env)", () => {
    assert.equal(
      resolvePayswapIdentityStateFile({
        env: { HOME: "", USERPROFILE: join("/", "Users", "zcode") },
      }),
      join("/", "Users", "zcode", ".payswap", "zcode", "telemetry-state.json"),
    );
  });

  test("prefers an explicit homeDir over env resolution (test/host injection seam)", () => {
    assert.equal(
      resolvePayswapIdentityStateFile({
        homeDir: "/explicit/home",
        env: { HOME: "/env/home" },
      }),
      "/explicit/home/.payswap/zcode/telemetry-state.json",
    );
  });

  test("exports the namespace constants all runtimes share", () => {
    assert.deepEqual([...PAYSWAP_ZCODE_IDENTITY_DIR_SEGMENTS], [".payswap", "zcode"]);
    assert.equal(PAYSWAP_ZCODE_TELEMETRY_STATE_FILE_NAME, "telemetry-state.json");
    assert.equal(PAYSWAP_ZCODE_TELEMETRY_LOCK_FILE_NAME, "telemetry-state.lock");
  });
});
