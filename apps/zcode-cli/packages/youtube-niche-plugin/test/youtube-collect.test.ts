import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNicheDatabase } from "#niche/db.ts";
import { computeMomentum } from "#niche/ranking.ts";
import { YouTubeClient, type FetchLike } from "#niche/youtube/client.ts";
import { collectForNiche } from "#niche/youtube/collect.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  url: string;
}

interface FixtureOptions {
  /** After this many videos.list calls the fixture doubles all stats
   * (simulates growth between two collection runs). */
  bumpViewsAfter?: number;
}

/** URL-routing fixture: /search is stateful (first run finds v1+v2, later
 * runs find the new v3), /videos and /channels echo the requested ids. */
const makeFixtureFetch = (seen: Recorded[], opts: FixtureOptions = {}): FetchLike => {
  let searchCalls = 0;
  let videosCalls = 0;
  const ok = (body: unknown) => ({ status: 200, json: async () => body });
  const known: Record<string, { title: string; channel: string; publishedAt: string; views: number; likes: number; comments: number; duration: string }> = {
    v1: { title: "Espresso 101", channel: "c1", publishedAt: "2026-11-01T00:00:00Z", views: 10000, likes: 400, comments: 100, duration: "PT10M" },
    v2: { title: "Grinder review", channel: "c2", publishedAt: "2026-11-15T00:00:00Z", views: 2000, likes: 80, comments: 10, duration: "PT5M" },
  };
  const videoItem = (id: string, bump: boolean) => {
    const base = known[id] ?? {
      title: `Video ${id}`,
      channel: "c3",
      publishedAt: "2026-11-16T00:00:00Z",
      views: 500,
      likes: 5,
      comments: 1,
      duration: "PT3M",
    };
    const scale = bump ? 2 : 1;
    return {
      id,
      snippet: { title: base.title, channelId: base.channel, publishedAt: base.publishedAt },
      statistics: {
        viewCount: String(base.views * scale),
        likeCount: String(base.likes * scale),
        commentCount: String(base.comments * scale),
      },
      contentDetails: { duration: base.duration },
    };
  };
  const requestedIds = (url: string) =>
    (new URL(url).searchParams.get("id") ?? "").split(",").filter(Boolean);
  return async (url) => {
    seen.push({ url });
    const path = new URL(url).pathname;
    if (path.endsWith("/search")) {
      searchCalls++;
      const items =
        searchCalls === 1
          ? [
              { id: { videoId: "v1" }, snippet: { channelId: "c1" } },
              { id: { videoId: "v2" }, snippet: { channelId: "c2" } },
            ]
          : [{ id: { videoId: "v3" }, snippet: { channelId: "c3" } }];
      return ok({ items });
    }
    if (path.endsWith("/videos")) {
      videosCalls++;
      const bump = opts.bumpViewsAfter != null && videosCalls > opts.bumpViewsAfter;
      return ok({ items: requestedIds(url).map((id) => videoItem(id, bump)) });
    }
    return ok({
      items: requestedIds(url).map((id) => ({
        id,
        snippet: { title: `Channel ${id}` },
        statistics: {},
      })),
    });
  };
};

const makeClient = (seen: Recorded[], opts: FixtureOptions = {}) => {
  const map = new Map<string, string>();
  return new YouTubeClient({
    kv: { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) },
    apiKey: "test-key",
    fetchFn: makeFixtureFetch(seen, opts),
  });
};

const openTempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
  dirs.push(dir);
  return openNicheDatabase(dir);
};

describe("collectForNiche", () => {
  it("searches, upserts videos and channels, and reports quota", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    const seen: Recorded[] = [];
    const client = makeClient(seen);

    const result = await collectForNiche(client, db, niche.id, "budget home espresso");
    expect(result.searched).toBe(true);
    expect(result.publishedAfter).toBeUndefined();
    expect(result.found).toBe(2);
    expect(result.collected).toBe(2);
    expect(result.channels).toBe(2);
    // nothing tracked yet: the refresh pass (and its quota unit) is skipped
    expect(result.refreshed).toBe(0);
    expect(result.tracked).toBe(0);
    // search(100) + videos.list(1) + channels.list(1)
    expect(result.quota).toEqual({ used: 102, limit: 10000, remaining: 9898 });
    // the first search carries no publishedAfter window
    expect(new URL(seen[0]!.url).searchParams.get("publishedAfter")).toBeNull();
    expect(db.listNiches()[0]!.channel_count).toBe(2);
    db.close();
  });

  it("skips the search within the recent-collection window without spending", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    const seen: Recorded[] = [];
    const client = makeClient(seen);

    const first = await collectForNiche(client, db, niche.id, "budget home espresso");
    expect(first.searched).toBe(true);
    const afterFirst = seen.length;
    const firstCollectedAt = db.getMeta(`last_collect:${niche.id}`);
    expect(firstCollectedAt).toBeTruthy();

    const second = await collectForNiche(client, db, niche.id, "budget home espresso");
    expect(second.searched).toBe(false);
    expect(second.skippedReason).toBe("recent");
    expect(second.lastCollectedAt).toBe(firstCollectedAt);
    // no additional API calls, quota unchanged
    expect(seen.length).toBe(afterFirst);
    expect(second.quota.used).toBe(first.quota.used);
    db.close();
  });

  it("re-collects with fresh=true and an incremental publishedAfter window", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    const seen: Recorded[] = [];
    const client = makeClient(seen);

    await collectForNiche(client, db, niche.id, "budget home espresso");
    const firstCollectedAt = db.getMeta(`last_collect:${niche.id}`);
    const second = await collectForNiche(client, db, niche.id, "budget home espresso", {
      fresh: true,
    });
    expect(second.searched).toBe(true);
    expect(second.publishedAfter).toBe(firstCollectedAt);
    const searchUrl = new URL(seen[3]!.url);
    expect(searchUrl.pathname.endsWith("/search")).toBe(true);
    expect(searchUrl.searchParams.get("publishedAfter")).toBe(firstCollectedAt);
    // the second run also refreshes the two tracked videos (4th call after the
    // run-2 search; equal collected_at ties break by id DESC → "v2,v1")
    const refreshUrl = new URL(seen[6]!.url);
    expect(refreshUrl.pathname.endsWith("/videos")).toBe(true);
    expect(refreshUrl.searchParams.get("id")).toBe("v2,v1");
    expect(second.refreshed).toBe(2);
    // upsert: v1, v2 from run 1 plus the new v3, no duplicates
    expect(db.listVideos(niche.id)).toHaveLength(3);
    db.close();
  });

  it("collects again once the skip window has passed", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    const seen: Recorded[] = [];
    const client = makeClient(seen);

    await collectForNiche(client, db, niche.id, "budget home espresso");
    const firstCollectedAt = db.getMeta(`last_collect:${niche.id}`);
    const later = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const second = await collectForNiche(client, db, niche.id, "budget home espresso", {}, later);
    expect(second.searched).toBe(true);
    expect(second.publishedAfter).toBe(firstCollectedAt);
    db.close();
  });

  it("refreshes tracked videos so momentum computes across runs (the Phase 7 fix)", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    const seen: Recorded[] = [];
    // run 1 videos.list keeps base stats; every later call doubles them.
    const client = makeClient(seen, { bumpViewsAfter: 1 });
    const day1 = new Date("2026-11-15T00:00:00.000Z");
    const day2 = new Date("2026-11-16T00:00:00.000Z");

    await collectForNiche(client, db, niche.id, "budget home espresso", {}, day1);
    const second = await collectForNiche(
      client,
      db,
      niche.id,
      "budget home espresso",
      { fresh: true },
      day2,
    );
    expect(second.tracked).toBe(2);
    expect(second.refreshed).toBe(2);

    // v1 now has two stats points (10000 → 20000), so momentum is no longer
    // "insufficient": recent 10000/day vs lifetime ~1333/day → accelerating.
    const stats = db.listVideoStats(niche.id);
    expect(stats.filter((point) => point.video_id === "v1").map((point) => point.view_count)).toEqual(
      [10000, 20000],
    );
    const momentum = computeMomentum(db.listVideos(niche.id), stats, day2);
    const byId = new Map(momentum.map((row) => [row.video.video_id, row]));
    expect(byId.get("v1")!.trend).toBe("accelerating");
    expect(byId.get("v2")!.trend).toBe("cooling");
    expect(byId.get("v3")!.trend).toBe("insufficient");
    // quota accounting is not asserted here: the client ledger stamps
    // wall-clock days, which diverges from these synthetic run dates (the
    // cap test below covers the +1-unit refresh cost with a single run).
    db.close();
  });

  it("caps the refresh pass at the 50 most recently collected tracked videos", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");
    for (let i = 1; i <= 60; i++) {
      db.addVideo(niche.id, {
        video_id: `s${i}`,
        title: `Seeded ${i}`,
        channel_id: "c9",
        published_at: "2026-11-01T00:00:00Z",
        view_count: 100,
        like_count: 1,
        comment_count: 0,
        duration_seconds: 60,
        collected_at: `2026-11-10T00:00:${String(i).padStart(2, "0")}Z`,
      });
    }
    const seen: Recorded[] = [];
    const client = makeClient(seen);

    const result = await collectForNiche(client, db, niche.id, "budget home espresso");
    expect(result.tracked).toBe(60);
    expect(result.refreshed).toBe(50);
    const refreshUrl = new URL(seen[seen.length - 1]!.url);
    expect(refreshUrl.pathname.endsWith("/videos")).toBe(true);
    const ids = (refreshUrl.searchParams.get("id") ?? "").split(",");
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("s60");
    expect(ids[49]).toBe("s11");
    // one extra videos.list unit for the refresh pass: 100 + 1 + 1 + 1
    expect(result.quota).toEqual({ used: 103, limit: 10000, remaining: 9897 });
    db.close();
  });
});
