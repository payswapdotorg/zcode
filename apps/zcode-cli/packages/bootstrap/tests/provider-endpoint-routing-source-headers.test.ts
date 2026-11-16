import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch as readOsArch, release as readOsRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderEndpointRoutingSourceHeaders } from "../src/provider-endpoint-routing-source-headers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("createProviderEndpointRoutingSourceHeaders", () => {
  it("adds runtime attribution and reuses an existing deviceMid from the PaySwap identity namespace", async () => {
    const dataBaseDir = await mkdtemp(
      join(tmpdir(), "zcode-routing-source-headers-"),
    );
    tempDirs.push(dataBaseDir);
    const stateDir = join(dataBaseDir, ".payswap", "zcode");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-routing-1" }),
      "utf8",
    );

    const headers = await createProviderEndpointRoutingSourceHeaders({
      appVersion: "1.2.3",
      env: {
        HOME: dataBaseDir,
        ZCODE_ENV: "test",
        ZCODE_TEST_BASE_URL: "https://routing-config.example.test",
      },
      sourceTitle: "electron",
    });

    expect(headers).toMatchObject({
      "HTTP-Referer": "https://routing-config.example.test",
      "User-Agent": "ZCode/1.2.3",
      "X-Client-Language": expect.any(String),
      "X-Client-Timezone": expect.any(String),
      "X-Device-Mid": "mid-routing-1",
      "X-Os-Category": osCategory(process.platform),
      "X-Os-Version": readOsRelease(),
      "X-Platform": `${process.platform}-${readOsArch()}`,
      "X-Release-Channel": "test",
      "X-Title": "Z Code@electron",
      "X-ZCode-App-Version": "1.2.3",
    });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("defaults to CLI attribution and does not create a missing device identity", async () => {
    const dataBaseDir = await mkdtemp(
      join(tmpdir(), "zcode-routing-no-device-mid-"),
    );
    tempDirs.push(dataBaseDir);

    const headers = await createProviderEndpointRoutingSourceHeaders({
      env: {
        HOME: dataBaseDir,
        ZCODE_ENV: "production",
        ZCODE_APP_VERSION: "2.0.0",
      },
    });

    expect(headers).toMatchObject({
      "HTTP-Referer": "https://zcode.z.ai",
      "User-Agent": "ZCode/2.0.0",
      "X-Release-Channel": "production",
      "X-Title": "Z Code@cli",
    });
    expect(headers).not.toHaveProperty("X-Device-Mid");
  });

  it("uses the Desktop-provided UI language for X-Client-Language", async () => {
    const dataBaseDir = await mkdtemp(join(tmpdir(), "zcode-routing-client-language-"));
    tempDirs.push(dataBaseDir);
    const headers = await createProviderEndpointRoutingSourceHeaders({
      env: { ZCODE_CLIENT_LANGUAGE: "ru-RU", HOME: dataBaseDir },
    });
    expect(headers["X-Client-Language"]).toBe("ru-RU");
  });

  it("never falls back to the legacy ~/.zcode/v2 identity namespace", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-routing-legacy-isolation-"));
    tempDirs.push(home);

    // 旧命名空间存在身份、新命名空间不存在：不得借用旧身份，也不得生成。
    const legacyDir = join(home, ".zcode", "v2");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-legacy-should-not-be-used" }),
      "utf8",
    );

    const legacyOnlyHeaders = await createProviderEndpointRoutingSourceHeaders({
      env: { HOME: home, ZCODE_ENV: "production", ZCODE_APP_VERSION: "2.0.0" },
    });
    expect(legacyOnlyHeaders).not.toHaveProperty("X-Device-Mid");

    // 新命名空间就绪后：只认新命名空间的身份。
    const identityDir = join(home, ".payswap", "zcode");
    await mkdir(identityDir, { recursive: true });
    await writeFile(
      join(identityDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-payswap-1" }),
      "utf8",
    );

    const headers = await createProviderEndpointRoutingSourceHeaders({
      env: { HOME: home, ZCODE_ENV: "production", ZCODE_APP_VERSION: "2.0.0" },
    });
    expect(headers["X-Device-Mid"]).toBe("mid-payswap-1");
  });

  it("ignores ZCODE_DATA_BASE_DIR for the device identity namespace", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-routing-home-axis-"));
    const dataBaseDir = await mkdtemp(join(tmpdir(), "zcode-routing-data-axis-"));
    tempDirs.push(home, dataBaseDir);

    // 身份只跟随 OS 主目录（HOME）；数据根指向别处时不得影响身份解析。
    const identityDir = join(home, ".payswap", "zcode");
    await mkdir(identityDir, { recursive: true });
    await writeFile(
      join(identityDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-home-axis-1" }),
      "utf8",
    );
    const decoyDir = join(dataBaseDir, ".payswap", "zcode");
    await mkdir(decoyDir, { recursive: true });
    await writeFile(
      join(decoyDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-data-axis-decoy" }),
      "utf8",
    );

    const headers = await createProviderEndpointRoutingSourceHeaders({
      env: {
        HOME: home,
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_ENV: "production",
        ZCODE_APP_VERSION: "2.0.0",
      },
    });
    expect(headers["X-Device-Mid"]).toBe("mid-home-axis-1");
  });
});

function osCategory(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}
