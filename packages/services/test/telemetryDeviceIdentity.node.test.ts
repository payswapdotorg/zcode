// PaySwap 设备身份命名空间回归 — services / 远端 server 侧（fork 专属）。
// App 业务单测已退役（docs/testing/unit-test-quality.md）；本文件沿用
// agent-crash-diagnostic.node.test.ts 的例外形态：node:test 定向取样、不进工程 Vitest
// 清单与 pre-push，经包脚本按路径显式执行。
// services 的 ensureTelemetryDeviceMid 是所有独立 Server 入口（createServerHostServices
// 装配的 SSH/WSL/Docker Core、ZCode Lite HTTP、旧 stdio entry）共用的设备身份入口。
// pnpm --filter @zcode/services test:payswap-identity
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ensureTelemetryDeviceMid } from "../src/telemetry/telemetryCore.js";

/* 身份锚定 OS 主目录的 <home>/.payswap/zcode/telemetry-state.json；
   不读取、不迁移、不回退旧 ~/.zcode/v2/telemetry-state.json。 */
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
  const home = await mkdtemp(join(tmpdir(), "zcode-services-identity-"));
  temporaryRoots.push(home);
  return home;
}

describe("ensureTelemetryDeviceMid (PaySwap identity namespace)", () => {
  test("creates <home>/.payswap/zcode/telemetry-state.json on first ensure and reuses it", async () => {
    const home = await createTemporaryHome();

    const first = await ensureTelemetryDeviceMid({ homeDir: home });
    assert.match(first, UUID_PATTERN);

    const state = JSON.parse(await readFile(identityStateFile(home), "utf8")) as {
      deviceMid?: string;
    };
    assert.equal(state.deviceMid, first);

    // 重启/二次调用：同一身份。
    const second = await ensureTelemetryDeviceMid({ homeDir: home });
    assert.equal(second, first);

    // 旧命名空间目录从未被创建。
    await assert.rejects(stat(join(home, ".zcode")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
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

    const generated = await ensureTelemetryDeviceMid();
    assert.match(generated, UUID_PATTERN);
    const raw = await readFile(identityStateFile(home), "utf8");
    assert.ok(raw.includes(generated));
  });

  test("never reads or migrates a legacy ~/.zcode/v2 identity", async () => {
    const home = await createTemporaryHome();
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      legacyStateFile(home),
      JSON.stringify({ deviceMid: "legacy-mid-must-not-leak" }, null, 2),
      "utf8",
    );

    const generated = await ensureTelemetryDeviceMid({ homeDir: home });

    assert.match(generated, UUID_PATTERN);
    assert.notEqual(generated, "legacy-mid-must-not-leak");
    // 新身份只落在 PaySwap 命名空间。
    const state = JSON.parse(await readFile(identityStateFile(home), "utf8")) as {
      deviceMid?: string;
    };
    assert.equal(state.deviceMid, generated);
    // 旧文件原样保留：不迁移、不覆盖、不删除。
    const legacyRaw = await readFile(legacyStateFile(home), "utf8");
    assert.ok(legacyRaw.includes("legacy-mid-must-not-leak"));
  });

  test("keeps using only the PaySwap namespace when both files exist", async () => {
    const home = await createTemporaryHome();
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      legacyStateFile(home),
      JSON.stringify({ deviceMid: "legacy-mid" }, null, 2),
      "utf8",
    );
    await mkdir(join(home, ".payswap", "zcode"), { recursive: true });
    await writeFile(
      identityStateFile(home),
      JSON.stringify({ deviceMid: "payswap-mid" }, null, 2),
      "utf8",
    );

    assert.equal(await ensureTelemetryDeviceMid({ homeDir: home }), "payswap-mid");
  });

  test("recovers from an invalid state file without corrupting unrelated data", async () => {
    const home = await createTemporaryHome();
    const identityDir = join(home, ".payswap", "zcode");
    await mkdir(identityDir, { recursive: true });
    await writeFile(join(identityDir, "unrelated.json"), '{"keep":true}', "utf8");
    await writeFile(join(identityDir, "telemetry-state.json"), "{not valid json", "utf8");

    const generated = await ensureTelemetryDeviceMid({ homeDir: home });
    assert.match(generated, UUID_PATTERN);

    const state = JSON.parse(await readFile(identityStateFile(home), "utf8")) as {
      deviceMid?: string;
    };
    assert.equal(state.deviceMid, generated);
    assert.equal(await readFile(join(identityDir, "unrelated.json"), "utf8"), '{"keep":true}');
  });

  test("concurrent ensures converge on one identity", async () => {
    const home = await createTemporaryHome();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureTelemetryDeviceMid({ homeDir: home })),
    );

    assert.equal(new Set(results).size, 1);
    const state = JSON.parse(await readFile(identityStateFile(home), "utf8")) as {
      deviceMid?: string;
    };
    assert.equal(state.deviceMid, results[0]);
  });

  test("recovers from a stale lock at the new namespace path", async () => {
    const home = await createTemporaryHome();
    const identityDir = join(home, ".payswap", "zcode");
    await mkdir(identityDir, { recursive: true });
    const lockFile = join(identityDir, "telemetry-state.lock");
    // 残留孤儿锁：owner 进程已死且 mtime 超过 5 分钟陈旧阈值。
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 999_999, createdAt: Date.now() - 10 * 60_000 }),
      "utf8",
    );
    const stale = new Date(Date.now() - 10 * 60_000);
    await utimes(lockFile, stale, stale);

    const generated = await ensureTelemetryDeviceMid({ homeDir: home });
    assert.match(generated, UUID_PATTERN);
    const raw = await readFile(identityStateFile(home), "utf8");
    assert.ok(raw.includes(generated));
  });
});
