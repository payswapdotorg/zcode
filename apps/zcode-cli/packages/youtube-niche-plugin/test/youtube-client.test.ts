import { describe, expect, it } from "vitest";
import {
  QuotaExceededError,
  YOUTUBE_API_BASE,
  YouTubeApiError,
  YouTubeClient,
  YouTubeNotConfiguredError,
  type FetchLike,
} from "#niche/youtube/client.ts";
import { readLedger, quotaDayKey, type QuotaKv } from "#niche/youtube/quota.ts";

const kv = (): QuotaKv => {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
  };
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/** fetch spy returning queued JSON fixtures (or a function for dynamic cases). */
function fixtureFetch(
  responses: Array<{ status: number; body: unknown }>,
  seen: Recorded[],
): FetchLike {
  let index = 0;
  return async (url, init) => {
    seen.push({ url, headers: init.headers ?? {} });
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return {
      status: response.status,
      json: async () => response.body,
    };
  };
}

const searchBody = {
  items: [
    { id: { videoId: "v1" }, snippet: { channelId: "c1" } },
    { id: { videoId: "v2" }, snippet: { channelId: "c1" } },
    { id: { videoId: "v3" }, snippet: { channelId: "c2" } },
  ],
};

const videosBody = {
  items: [
    {
      id: "v1",
      snippet: { title: "Espresso 101", channelId: "c1", publishedAt: "2026-11-01T00:00:00Z" },
      statistics: { viewCount: "10000", likeCount: "400", commentCount: "100" },
      contentDetails: { duration: "PT1M30S" },
    },
    {
      id: "v2",
      snippet: { title: "Live stream", channelId: "c1" },
      statistics: { viewCount: "5" },
      contentDetails: { duration: "PT0S" },
    },
  ],
};

describe("YouTubeClient", () => {
  it("refuses to call the API without credentials and spends no quota", async () => {
    const store = kv();
    const seen: Recorded[] = [];
    const client = new YouTubeClient({ kv: store, fetchFn: fixtureFetch([], seen) });
    await expect(client.searchVideoIds("espresso")).rejects.toBeInstanceOf(
      YouTubeNotConfiguredError,
    );
    expect(readLedger(store, new Date()).used).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("searches, records 100 units and dedupes channel ids", async () => {
    const store = kv();
    const seen: Recorded[] = [];
    const client = new YouTubeClient({
      kv: store,
      apiKey: "test-key",
      fetchFn: fixtureFetch([{ status: 200, body: searchBody }], seen),
    });
    const search = await client.searchVideoIds("budget espresso", { maxResults: 5 });
    expect(search).toEqual({ videoIds: ["v1", "v2", "v3"], channelIds: ["c1", "c2"] });
    expect(readLedger(store, new Date()).used).toBe(100);

    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe(`${YOUTUBE_API_BASE}/search`);
    expect(url.searchParams.get("q")).toBe("budget espresso");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("maxResults")).toBe("5");
    expect(url.searchParams.get("key")).toBe("test-key");
  });

  it("prefers the bearer token over the key parameter", async () => {
    const store = kv();
    const seen: Recorded[] = [];
    const client = new YouTubeClient({
      kv: store,
      apiKey: "test-key",
      accessToken: "at-1",
      fetchFn: fixtureFetch([{ status: 200, body: searchBody }], seen),
    });
    await client.searchVideoIds("q");
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("key")).toBeNull();
    expect(seen[0]!.headers.Authorization).toBe("Bearer at-1");
  });

  it("maps videos.list statistics and parses durations", async () => {
    const store = kv();
    const seen: Recorded[] = [];
    const client = new YouTubeClient({
      kv: store,
      apiKey: "test-key",
      fetchFn: fixtureFetch([{ status: 200, body: videosBody }], seen),
    });
    const stats = await client.fetchVideoStats(["v1", "v2"]);
    expect(stats).toEqual([
      {
        videoId: "v1",
        title: "Espresso 101",
        channelId: "c1",
        publishedAt: "2026-11-01T00:00:00Z",
        viewCount: 10000,
        likeCount: 400,
        commentCount: 100,
        durationSeconds: 90,
      },
      {
        videoId: "v2",
        title: "Live stream",
        channelId: "c1",
        publishedAt: null,
        viewCount: 5,
        likeCount: null,
        commentCount: null,
        durationSeconds: null,
      },
    ]);
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("id")).toBe("v1,v2");
    expect(readLedger(store, new Date()).used).toBe(1);
  });

  it("chunks more than 50 ids into separate requests and counts the units", async () => {
    const store = kv();
    const seen: Recorded[] = [];
    const ids = Array.from({ length: 51 }, (_, index) => `v${index}`);
    const client = new YouTubeClient({
      kv: store,
      apiKey: "test-key",
      fetchFn: fixtureFetch([{ status: 200, body: { items: [] } }], seen),
    });
    await client.fetchVideoStats(ids);
    expect(seen).toHaveLength(2);
    expect(new URL(seen[0]!.url).searchParams.get("id")).toBe(ids.slice(0, 50).join(","));
    expect(new URL(seen[1]!.url).searchParams.get("id")).toBe("v50");
    expect(readLedger(store, new Date()).used).toBe(2);
  });

  it("refuses over-budget calls before any request goes out", async () => {
    const store = kv();
    // Same day key the ledger itself uses (Pacific calendar day, not UTC).
    store.set("youtube_quota_day", quotaDayKey(new Date()));
    store.set("youtube_quota_used", "9950"); // one search short of the limit
    const seen: Recorded[] = [];
    const client = new YouTubeClient({
      kv: store,
      apiKey: "test-key",
      fetchFn: fixtureFetch([{ status: 200, body: searchBody }], seen),
    });
    await expect(client.searchVideoIds("espresso")).rejects.toBeInstanceOf(QuotaExceededError);
    expect(seen).toHaveLength(0);
  });

  it("maps API error payloads to YouTubeApiError with the reason", async () => {
    const store = kv();
    const client = new YouTubeClient({
      kv: store,
      apiKey: "test-key",
      fetchFn: fixtureFetch(
        [
          {
            status: 403,
            body: {
              error: {
                code: 403,
                message: "The request cannot be completed because you have exceeded your quota.",
                errors: [{ reason: "quotaExceeded" }],
              },
            },
          },
        ],
        [],
      ),
    });
    // Note: the local ledger already spent 100 units on this call — the API-side
    // refusal arrives after the request; both surfaces are exercised here.
    await expect(client.searchVideoIds("espresso")).rejects.toMatchObject({
      name: "YouTubeApiError",
      status: 403,
      reason: "quotaExceeded",
    });
    expect(new YouTubeApiError(403, "r", "m").message).toBe("m");
  });
});
