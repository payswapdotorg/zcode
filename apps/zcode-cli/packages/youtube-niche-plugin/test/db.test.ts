import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NicheExistsError, openNicheDatabase, resolveNicheDataDir } from "#niche/db.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openTempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
  dirs.push(dir);
  return openNicheDatabase(dir);
};

describe("resolveNicheDataDir", () => {
  it("prefers the host-provided plugin data directory, then falls back to the workspace", () => {
    expect(resolveNicheDataDir({ YOUTUBE_NICHE_PLUGIN_DATA: "/plugin-data" }, "/cwd")).toBe(
      "/plugin-data",
    );
    expect(resolveNicheDataDir({ ZCODE_PLUGIN_DATA: "/shared" }, "/cwd")).toBe("/shared");
    expect(resolveNicheDataDir({}, "/cwd")).toBe(join("/cwd", ".youtube-niche"));
  });
});

describe("openNicheDatabase", () => {
  it("adds, lists and removes niches with counts", () => {
    const db = openTempDb();
    db.addNiche("budget home espresso", "small kitchen gear");
    db.addNiche("desk setups");

    const niches = db.listNiches();
    expect(niches.map((niche) => niche.name)).toEqual([
      "desk setups",
      "budget home espresso",
    ]);
    expect(niches[1]!.notes).toBe("small kitchen gear");
    expect(niches[1]!.channel_count).toBe(0);
    expect(niches[1]!.video_count).toBe(0);

    expect(db.removeNiche("desk setups")).toBe(true);
    expect(db.removeNiche("desk setups")).toBe(false);
    expect(db.listNiches()).toHaveLength(1);
    db.close();
  });

  it("rejects duplicate niche names and survives reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
    dirs.push(dir);
    const db = openNicheDatabase(dir);
    db.addNiche("niche");
    expect(() => db.addNiche("niche")).toThrow(NicheExistsError);
    db.close();

    const reopened = openNicheDatabase(dir);
    expect(reopened.listNiches().map((niche) => niche.name)).toEqual(["niche"]);
    reopened.close();
  });
});
