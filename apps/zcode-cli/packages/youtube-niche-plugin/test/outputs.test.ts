import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { YOUTUBE_NICHE_PLUGIN_OUTPUTS } from "../contract.ts";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readable = (path: string) => {
  accessSync(path, constants.R_OK);
  return true;
};

describe("build outputs", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: pkgRoot, stdio: "pipe" });
  }, 60000);

  it("produces every contracted output", () => {
    for (const output of YOUTUBE_NICHE_PLUGIN_OUTPUTS) {
      expect(readable(join(pkgRoot, output))).toBe(true);
    }
  });

  it("inlines the panel bootstrap without leftovers", () => {
    const html = readFileSync(join(pkgRoot, "dist/ui/panel.html"), "utf8");
    expect(html).not.toContain("__PANEL_BOOTSTRAP__");
    expect(html).toContain("Niche Explorer");
    expect(html).toContain("niche_list");
  });
});
