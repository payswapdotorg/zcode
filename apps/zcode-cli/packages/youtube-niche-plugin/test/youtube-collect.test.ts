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

/** Fresh fetch closure per client: search → videos.list → channels.list. */
const makeFixtureFetch = (): FetchLike => {
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
  return async () => {
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return { status: response.status, json: async () => response.body };
  };
};

const makeClient = () => {
  const map = new Map<string, string>();
  const client = new YouTubeClient({
    kv: { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) },
    apiKey: "test-key",
    fetchFn: makeFixtureFetch(),
  });
  return client;
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
    const client = makeClient();

    const result = await collectForNiche(client, db, niche.id, "budget home espresso");
    expect(result.found).toBe(2);
    expect(result.collected).toBe(2);
    expect(result.channels).toBe(2);
    // search(100) + videos.list(1) + channels.list(1)
    expect(result.quota).toEqual({ used: 102, limit: 10000, remaining: 9898 });

    const videos = db.listVideos(niche.id);
    expect(videos.map((video) => video.video_id).sort()).toEqual(["v1", "v2"]);
    const first = videos.find((video) => video.video_id === "v1")!;
    expect(first.title).toBe("Espresso 101");
    expect(first.duration_seconds).toBe(600);
    expect(first.channel_id).toBe("c1");
    // channel_count comes from the channels table subquery.
    expect(db.listNiches()[0]!.channel_count).toBe(2);
    db.close();
  });

  it("re-collection refreshes stats instead of duplicating rows", async () => {
    const db = openTempDb();
    const niche = db.addNiche("budget home espresso");

    await collectForNiche(makeClient(), db, niche.id, "budget home espresso");
    await collectForNiche(makeClient(), db, niche.id, "budget home espresso");
    expect(db.listVideos(niche.id)).toHaveLength(2);
    expect(db.listNiches()[0]!.video_count).toBe(2);
    db.close();
  });
});
