import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VideoRecord } from "#niche/contract.ts";
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

  it("upserts videos, counts them per niche, and cascades on niche removal", () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    const second = db.addNiche("desk setups");
    expect(db.getNiche("budget home espresso")!.id).toBe(niche.id);
    expect(db.getNiche("missing")).toBeUndefined();

    const snapshot = (over: Partial<VideoRecord> = {}): VideoRecord => ({
      video_id: "v1",
      title: "Old title",
      channel_id: "c1",
      published_at: "2026-11-01T00:00:00.000Z",
      view_count: 100,
      like_count: 5,
      comment_count: 1,
      duration_seconds: 300,
      collected_at: "2026-11-16T00:00:00.000Z",
      ...over,
    });
    expect(db.addVideo(niche.id, snapshot())).toBe(true);
    // Same video_id re-collected: stats refresh instead of duplicating.
    expect(
      db.addVideo(
        niche.id,
        snapshot({ title: "New title", view_count: 250, collected_at: "2026-11-17T00:00:00.000Z" }),
      ),
    ).toBe(true);
    db.addVideo(second.id, snapshot({ video_id: "other", title: "Other niche" }));

    const videos = db.listVideos(niche.id);
    expect(videos).toHaveLength(1);
    expect(videos[0]!.title).toBe("New title");
    expect(videos[0]!.view_count).toBe(250);
    expect(db.listNiches().find((row) => row.id === niche.id)!.video_count).toBe(1);

    db.removeNiche("budget home espresso");
    expect(db.listVideos(niche.id)).toHaveLength(0);
    expect(db.listVideos(second.id)).toHaveLength(1);
    db.close();
  });
});

describe("listChannels", () => {
  it("lists tracked channels per niche and refreshes titles on re-add", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-db-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    const first = db.addNiche("espresso");
    const second = db.addNiche("other");
    db.addChannel(first.id, "c1", "Channel One");
    db.addChannel(first.id, "c2", "Channel Two");
    db.addChannel(second.id, "c3", "Elsewhere");
    expect(db.listChannels(first.id)).toEqual([
      { channel_id: "c1", title: "Channel One" },
      { channel_id: "c2", title: "Channel Two" },
    ]);
    // Upsert refreshes the title without duplicating the row.
    db.addChannel(first.id, "c1", "Channel One!");
    expect(db.listChannels(first.id)).toHaveLength(2);
    expect(db.listChannels(first.id)[0]).toMatchObject({ title: "Channel One!" });
  });
});
