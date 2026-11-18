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

describe("video stats history (v2)", () => {
  const baseVideo = {
    video_id: "v1",
    title: "V1",
    channel_id: "c1",
    published_at: "2026-11-01T00:00:00Z",
    like_count: 10,
    comment_count: 1,
    duration_seconds: 60,
  } as const;

  it("records one stats point per collection with view data", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-db-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    const niche = db.addNiche("espresso");
    db.addVideo(niche.id, { ...baseVideo, view_count: 1000, collected_at: "2026-11-07T00:00:00Z" });
    db.addVideo(niche.id, { ...baseVideo, view_count: 4000, collected_at: "2026-11-17T00:00:00Z" });
    const stats = db.listVideoStats(niche.id);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({ video_id: "v1", snapshot_at: "2026-11-07T00:00:00Z", view_count: 1000 });
    expect(stats[1]).toMatchObject({ snapshot_at: "2026-11-17T00:00:00Z", view_count: 4000 });
    // Videos without view data record nothing.
    db.addVideo(niche.id, {
      ...baseVideo,
      video_id: "v2",
      view_count: null,
      collected_at: "2026-11-17T00:00:00Z",
    });
    expect(db.listVideoStats(niche.id)).toHaveLength(2);
  });

  it("stamps schema v2 and upgrades a v1 database additively", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-db-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    expect(db.getMeta("schema_version")).toBe("2");
    db.setMeta("schema_version", "1");
    db.close();
    // Reopening an old-database runs the additive migration and re-stamps.
    const reopened = openNicheDatabase(dataDir);
    expect(reopened.getMeta("schema_version")).toBe("2");
    const niche = reopened.addNiche("espresso");
    reopened.addVideo(niche.id, { ...baseVideo, view_count: 10, collected_at: "2026-11-17T00:00:00Z" });
    expect(reopened.listVideoStats(niche.id)).toHaveLength(1);
    reopened.close();
  });
});
