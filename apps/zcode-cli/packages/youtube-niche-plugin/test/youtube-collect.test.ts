import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNicheDatabase } from "#niche/db.ts";
import { YouTubeClient, type FetchLike } from "#niche/youtube/client.ts";
import { collectForNiche } from "#niche/youtube/collect.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  url: string;
}

/** Fresh fixture fetch per client: search → videos.list → channels.list. */
const makeFixtureFetch = (seen: Recorded[]): FetchLike => {
  const responses = [
    {
      status: 200,
      body: {
        items: [
          { id: { videoId: "v1" }, snippet: { channelId: "c1" } },
          { id: { videoId: "v2" }, snippet: { channelId: "c2" } },
        ],
      },
    },
    {
      status: 200,
      body: {
        items: [
          {
            id: "v1",
            snippet: {
              title: "Espresso 101",
              channelId: "c1",
              publishedAt: "2026-11-01T00:00:00Z",
            },
            statistics: { viewCount: "10000", likeCount: "400", commentCount: "100" },
            contentDetails: { duration: "PT10M" },
          },
          {
            id: "v2",
            snippet: {
              title: "Grinder review",
              channelId: "c2",
              publishedAt: "2026-11-15T00:00:00Z",
            },
            statistics: { viewCount: "2000", likeCount: "80", commentCount: "10" },
            contentDetails: { duration: "PT5M" },
          },
        ],
      },
    },
    {
      status: 200,
      body: {
        items: [
          { id: "c1", snippet: { title: "Channel One" }, statistics: { subscriberCount: "1200" } },
          { id: "c2", snippet: { title: "Channel Two" }, statistics: {} },
        ],
      },
    },
  ];
  let index = 0;
  return async (url) => {
    seen.push({ url });
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return { status: response.status, json: async () => response.body };
  };
};

const makeClient = (seen: Recorded[]) => {
  const map = new Map<string, string>();
  return new YouTubeClient({
    kv: { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) },
    apiKey: "test-key",
    fetchFn: makeFixtureFetch(seen),
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
    expect(searchUrl.searchParams.get("publishedAfter")).toBe(firstCollectedAt);
    // upsert: same two videos, not duplicates
    expect(db.listVideos(niche.id)).toHaveLength(2);
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
});
