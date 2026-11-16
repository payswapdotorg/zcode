// PaySwap 设备身份命名空间回归 — Desktop main 侧（fork 专属）。
// App 业务单测已退役（docs/testing/unit-test-quality.md）；本文件沿用
// agent-crash-diagnostic.node.test.ts 的例外形态：node:test 定向取样、不进工程 Vitest
// 清单与 pre-push，经包脚本按路径显式执行。
// ensureDesktopDeviceMidSync 在窗口创建前同步确保设备身份（index.ts / appARMSBootstrap /
// databaseStartupTelemetry 均经它取值），与 telemetryCore 共用同一身份文件。
// pnpm --filter @zcode/desktop test:payswap-identity
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ensureDesktopDeviceMidSync } from "../src/main/desktopDeviceMid.js";

/* 身份锚定 OS 主目录的 <home>/.payswap/zcode/telemetry-state.json；
   不读取、不迁移、不回退旧 ~/.zcode/v2/telemetry-state.json；保留 state 其它字段；fs 异常兜底不抛。 */
const temporaryRoots: string[] = [];

after(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identityStateFile(home: string): string {
  return join(home, ".payswap", "zcode", "telemetry-state.json");
}

function legacyStateFile(home: string): string {
  return join(home, ".zcode", "v2", "telemetry-state.json");
}

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-desktop-identity-"));
  temporaryRoots.push(home);
  return home;
}

describe("ensureDesktopDeviceMidSync (PaySwap identity namespace)", () => {
  test("creates the identity under the injected state dir and reuses it on restart", async () => {
    const home = await createTemporaryHome();
    const stateDir = join(home, ".payswap", "zcode");

    const first = ensureDesktopDeviceMidSync({ stateDir });
    assert.match(first, UUID_PATTERN);
    const state = JSON.parse(await readFile(join(stateDir, "telemetry-state.json"), "utf8")) as {
      deviceMid?: string;
    };
    assert.equal(state.deviceMid, first);

    // 重启：同一身份。
    assert.equal(ensureDesktopDeviceMidSync({ stateDir }), first);
  });

  test("resolves the default path from the OS home directory (env HOME)", async (t) => {
    const home = await createTemporaryHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    });

    const generated = ensureDesktopDeviceMidSync();
    assert.match(generated, UUID_PATTERN);
    const raw = await readFile(identityStateFile(home), "utf8");
    assert.ok(raw.includes(generated));
  });

  test("creates the identity directory recursively when missing", async () => {
    const home = await createTemporaryHome();
    const stateDir = join(home, "nested", ".payswap", "zcode");

    const generated = ensureDesktopDeviceMidSync({ stateDir });
    assert.match(generated, UUID_PATTERN);
    const raw = await readFile(join(stateDir, "telemetry-state.json"), "utf8");
    assert.ok(raw.includes(generated));
  });

  test("preserves other telemetry state properties when adding deviceMid", async () => {
    const home = await createTemporaryHome();
    const stateDir = join(home, ".payswap", "zcode");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "telemetry-state.json"),
      JSON.stringify({ lastDailyActiveDate: "2026-11-01", dailyActiveInFlight: null }, null, 2),
      "utf8",
    );

    const generated = ensureDesktopDeviceMidSync({ stateDir });

    const state = JSON.parse(
      await readFile(join(stateDir, "telemetry-state.json"), "utf8"),
    ) as {
      dailyActiveInFlight?: unknown;
      deviceMid?: string;
      lastDailyActiveDate?: string;
    };
    assert.deepEqual(state, {
      dailyActiveInFlight: null,
      deviceMid: generated,
      lastDailyActiveDate: "2026-11-01",
    });
  });

  test("never reads or migrates a legacy ~/.zcode/v2 identity", async (t) => {
    const home = await createTemporaryHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    });
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      legacyStateFile(home),
      JSON.stringify({ deviceMid: "legacy-mid-must-not-leak" }, null, 2),
      "utf8",
    );

    const generated = ensureDesktopDeviceMidSync();

    assert.match(generated, UUID_PATTERN);
    assert.notEqual(generated, "legacy-mid-must-not-leak");
    const raw = await readFile(identityStateFile(home), "utf8");
    assert.ok(raw.includes(generated));
    // 旧文件原样保留。
    const legacyRaw = await readFile(legacyStateFile(home), "utf8");
    assert.ok(legacyRaw.includes("legacy-mid-must-not-leak"));
  });

  test("recovers from an invalid state file without throwing", async () => {
    const home = await createTemporaryHome();
    const stateDir = join(home, ".payswap", "zcode");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "telemetry-state.json"), "{corrupted", "utf8");

    const generated = ensureDesktopDeviceMidSync({ stateDir });
    assert.match(generated, UUID_PATTERN);
    const state = JSON.parse(await readFile(join(stateDir, "telemetry-state.json"), "utf8")) as {
      deviceMid?: string;
    };
    assert.equal(state.deviceMid, generated);
  });

  test("returns a usable fallback when persistence fails, without throwing", async () => {
    const home = await createTemporaryHome();
    // 用普通文件堵住身份目录：mkdirSync 失败，函数仍必须返回可用 ID 且不抛。
    const blocked = join(home, "not-a-directory");
    await writeFile(blocked, "blocked", "utf8");
    let createCount = 0;
    const createId = () => `fallback-${++createCount}`;

    const first = ensureDesktopDeviceMidSync({ stateDir: join(blocked, "zcode"), createId });
    const second = ensureDesktopDeviceMidSync({ stateDir: join(blocked, "zcode"), createId });

    // 契约：不抛、每次都返回可用 ID（try 内生成一次、写盘失败后 catch 兜底再生成一次）。
    assert.ok(first.startsWith("fallback-"));
    assert.ok(second.startsWith("fallback-"));
    assert.ok(createCount >= 2);
  });
});
