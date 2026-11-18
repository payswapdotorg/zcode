import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { PANEL_URI } from "#niche/contract.ts";
import { openNicheDatabase } from "#niche/db.ts";
import { createNicheServer } from "#niche/server.ts";
import { YouTubeClient, type FetchLike } from "#niche/youtube/client.ts";
import { quotaDayKey } from "#niche/youtube/quota.ts";
import type { TokenPost } from "#niche/youtube/oauth.ts";
import { loadTokens } from "#niche/youtube/token-store.ts";

interface ConnectDeps {
  youtube?: YouTubeClient;
  tokenKey?: Buffer;
  dataDir?: string;
  clientId?: string;
  post?: TokenPost;
}

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixtureFetch: FetchLike = (() => {
  const responses = [
    {
      status: 200,
      body: { items: [{ id: { videoId: "v1" }, snippet: { channelId: "c1" } }] },
    },
    {
      status: 200,
      body: {
        items: [
          {
            id: "v1",
            snippet: { title: "Espresso 101", channelId: "c1", publishedAt: "2026-11-10T00:00:00Z" },
            statistics: { viewCount: "5000", likeCount: "200", commentCount: "50" },
            contentDetails: { duration: "PT8M" },
          },
        ],
      },
    },
    {
      status: 200,
      body: { items: [{ id: "c1", snippet: { title: "Channel One" } }] },
    },
  ];
  let index = 0;
  return async () => {
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return { status: response.status, json: async () => response.body };
  };
})();

async function connect(opts: ConnectDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
  dirs.push(dir);
  const db = openNicheDatabase(dir);
  const server = createNicheServer({
    db,
    assetRoot: resolve(import.meta.dirname, "../ui"),
    ...(opts.youtube ? { youtube: opts.youtube } : {}),
    ...(opts.tokenKey ? { tokenKey: opts.tokenKey } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    ...(opts.post ? { post: opts.post } : {}),
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  return { client, db };
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("\n");
};

describe("youtube-niche server", () => {
  it("serves the Niche Explorer panel resource", async () => {
    const { client } = await connect();
    const resource = await client.readResource({ uri: PANEL_URI });
    const [first] = resource.contents as Array<{ uri: string; text?: string; mimeType?: string }>;
    expect(first?.mimeType).toBe("text/html");
    expect(first?.text).toContain("Niche Explorer");
  });

  it("adds, lists and removes niches through tools", async () => {
    const { client } = await connect();
    const added = await client.callTool({
      name: "niche_add",
      arguments: { name: "budget home espresso", notes: "gear" },
    });
    expect(textOf(added)).toContain("budget home espresso");

    const duplicate = await client.callTool({
      name: "niche_add",
      arguments: { name: "budget home espresso" },
    });
    expect(textOf(duplicate)).toContain("already tracked");

    const listed = await client.callTool({ name: "niche_list", arguments: {} });
    expect(textOf(listed)).toContain("budget home espresso");
    expect(textOf(listed)).toContain("channels: 0");

    const removed = await client.callTool({
      name: "niche_remove",
      arguments: { name: "budget home espresso" },
    });
    expect(textOf(removed)).toContain("Removed");

    const empty = await client.callTool({ name: "niche_list", arguments: {} });
    expect(textOf(empty)).toContain("No niches tracked yet");
  });

  it("ranks collected videos of a niche", async () => {
    const { client, db } = await connect();
    const niche = db.addNiche("budget home espresso");
    const day = 24 * 60 * 60 * 1000;
    db.addVideo(niche.id, {
      video_id: "slow",
      title: "Slow burner",
      channel_id: "c1",
      published_at: new Date(Date.now() - 10 * day).toISOString(),
      view_count: 10000,
      like_count: 100,
      comment_count: 0,
      duration_seconds: null,
      collected_at: new Date().toISOString(),
    });
    db.addVideo(niche.id, {
      video_id: "fast",
      title: "Fast riser",
      channel_id: "c2",
      published_at: new Date(Date.now() - 2 * day).toISOString(),
      view_count: 6000,
      like_count: 300,
      comment_count: 100,
      duration_seconds: null,
      collected_at: new Date().toISOString(),
    });

    const ranked = await client.callTool({
      name: "niche_rank",
      arguments: { name: "budget home espresso" },
    });
    const text = textOf(ranked);
    expect(text).toContain("1. Fast riser");
    expect(text).toContain("2. Slow burner");
    expect(text).toContain("(fast)");

    const untracked = await client.callTool({ name: "niche_rank", arguments: { name: "nope" } });
    expect(textOf(untracked)).toContain("not tracked");

    const fresh = await connect();
    fresh.db.addNiche("empty niche");
    const noVideos = await fresh.client.callTool({
      name: "niche_rank",
      arguments: { name: "empty niche" },
    });
    expect(textOf(noVideos)).toContain("No videos collected");
  });

  it("reports an honest not-configured state for niche_collect without credentials", async () => {
    const { client } = await connect();
    const added = await client.callTool({
      name: "niche_add",
      arguments: { name: "budget home espresso" },
    });
    expect(textOf(added)).toContain("budget home espresso");

    const result = await client.callTool({
      name: "niche_collect",
      arguments: { name: "budget home espresso" },
    });
    expect(textOf(result)).toContain("not configured");
    expect(textOf(result)).toContain("R2");

    const untracked = await client.callTool({
      name: "niche_collect",
      arguments: { name: "nope" },
    });
    expect(textOf(untracked)).toContain("not tracked");
  });

  it("collects videos through an injected YouTube client", async () => {
    const map = new Map<string, string>();
    const youtube = new YouTubeClient({
      kv: { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) },
      apiKey: "test-key",
      fetchFn: fixtureFetch,
    });
    const { client, db } = await connect({ youtube });
    db.addNiche("budget home espresso");

    const result = await client.callTool({
      name: "niche_collect",
      arguments: { name: "budget home espresso" },
    });
    const text = textOf(result);
    expect(text).toContain("Collected 1 new-or-refreshed videos");
    expect(text).toContain("quota: 102/10000");

    const niche = db.getNiche("budget home espresso")!;
    const videos = db.listVideos(niche.id);
    expect(videos).toHaveLength(1);
    expect(videos[0]!.title).toBe("Espresso 101");
    expect(videos[0]!.view_count).toBe(5000);
  });

  it("lists collected videos and reports quota in niche_list", async () => {
    // Preset the ledger with the day key it itself uses (Pacific day, not UTC).
    const map = new Map<string, string>([
      ["youtube_quota_day", quotaDayKey(new Date())],
      ["youtube_quota_used", "250"],
    ]);
    const youtube = new YouTubeClient({
      kv: { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) },
      apiKey: "test-key",
      fetchFn: fixtureFetch,
    });
    const { client, db } = await connect({ youtube });
    const niche = db.addNiche("budget home espresso");
    db.addVideo(niche.id, {
      video_id: "v1",
      title: "Espresso 101",
      channel_id: "c1",
      published_at: "2026-11-10T00:00:00Z",
      view_count: 5000,
      like_count: 200,
      comment_count: 50,
      duration_seconds: 480,
      collected_at: new Date().toISOString(),
    });

    const listed = await client.callTool({ name: "niche_list", arguments: {} });
    const quota = (listed as { structuredContent?: { quota?: { used: number } } })
      .structuredContent?.quota;
    expect(quota?.used).toBe(250);

    const videos = await client.callTool({
      name: "niche_videos",
      arguments: { name: "budget home espresso" },
    });
    const text = textOf(videos);
    expect(text).toContain("1. Espresso 101");
    expect(text).toContain("5000 views");
    expect(text).toContain("8 min");

    const untracked = await client.callTool({
      name: "niche_videos",
      arguments: { name: "nope" },
    });
    expect(textOf(untracked)).toContain("not tracked");

    const empty = await connect({ youtube });
    const emptyNiche = empty.db.addNiche("empty niche");
    expect(emptyNiche.video_count).toBe(0);
    const noVideos = await empty.client.callTool({
      name: "niche_videos",
      arguments: { name: "empty niche" },
    });
    expect(textOf(noVideos)).toContain("No videos collected");
  });

  it("reports an honest unconfigured state for youtube_connect", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "youtube_connect", arguments: {} });
    expect(textOf(result)).toContain("not configured");
    expect(textOf(result)).toContain("R2");

    const finish = await client.callTool({ name: "youtube_connect_finish", arguments: {} });
    expect(textOf(finish)).toContain("No consent flow is pending");
  });

  it("runs the two-step connect flow and stores encrypted tokens", async () => {
    const tokenKey = randomBytes(32);
    const dataDir = mkdtempSync(join(tmpdir(), "youtube-niche-tokens-"));
    dirs.push(dataDir);
    const post: TokenPost = async () => ({
      status: 200,
      json: {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      },
    });
    const { client } = await connect({ tokenKey, dataDir, clientId: "cid", post });

    const started = await client.callTool({ name: "youtube_connect", arguments: {} });
    const structured = (started as {
      structuredContent?: { authUrl?: string; port?: number; state?: string };
    }).structuredContent;
    expect(textOf(started)).toContain("Consent flow started");
    expect(structured?.authUrl).toContain("accounts.google.com");

    const state = structured!.state!;
    const port = structured!.port!;
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=ac-1&state=${state}`);
    expect(response.status).toBe(200);

    const finished = await client.callTool({ name: "youtube_connect_finish", arguments: {} });
    expect(textOf(finished)).toContain("YouTube connected");
    expect(textOf(finished)).toContain("niche_collect is live");

    // Round-trip: the stored file decrypts with the same key.
    const tokens = loadTokens(dataDir, tokenKey);
    expect(tokens?.access_token).toBe("at-1");
    expect(tokens?.refresh_token).toBe("rt-1");

    // After connecting, niche_list carries the quota of the OAuth client.
    const listed = await client.callTool({ name: "niche_list", arguments: {} });
    const quota = (listed as { structuredContent?: { quota?: { limit: number } } })
      .structuredContent?.quota;
    expect(quota?.limit).toBe(10000);

    // A second connect while tokens are valid reports the existing session.
    const again = await client.callTool({ name: "youtube_connect", arguments: {} });
    expect(textOf(again)).toContain("already connected");
  });
});

describe("niche_export tool", () => {
  it("exports collected videos to CSV in the data directory", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "niche-export-tool-"));
    dirs.push(exportDir);
    const { client, db } = await connect({ dataDir: exportDir });
    const added = db.addNiche("budget home espresso");
    db.addVideo(added.id, {
      video_id: "v1",
      title: "Espresso, \"ranked\"",
      channel_id: "c1",
      published_at: "2026-11-11T00:00:00Z",
      view_count: 5000,
      like_count: 200,
      comment_count: 50,
      duration_seconds: 480,
      collected_at: "2026-11-17T00:00:00Z",
    });
    const result = await client.callTool({
      name: "niche_export",
      arguments: { name: "budget home espresso", format: "csv" },
    });
    expect(textOf(result)).toContain("Exported 1 videos");
    const structured = (result as { structuredContent?: { path?: string } }).structuredContent;
    expect(structured?.path).toMatch(/exports\/niche-budget-home-espresso-\d{8}-\d{4}\.csv$/);
    const content = readFileSync(structured!.path!, "utf8");
    expect(content).toContain('"Espresso, ""ranked"""');
    expect(content.split("\n")[0]).toContain("views_per_day");
  });

  it("exports Markdown with the niche heading", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "niche-export-tool-"));
    dirs.push(exportDir);
    const { client, db } = await connect({ dataDir: exportDir });
    const added = db.addNiche("espresso");
    db.addVideo(added.id, {
      video_id: "v1",
      title: "V1",
      channel_id: "c1",
      published_at: "2026-11-11T00:00:00Z",
      view_count: 100,
      like_count: 5,
      comment_count: 1,
      duration_seconds: 60,
      collected_at: "2026-11-17T00:00:00Z",
    });
    const result = await client.callTool({
      name: "niche_export",
      arguments: { name: "espresso", format: "markdown" },
    });
    const structured = (result as { structuredContent?: { path?: string } }).structuredContent;
    expect(structured?.path).toMatch(/\.md$/);
    expect(readFileSync(structured!.path!, "utf8")).toContain("# espresso — collected videos");
  });

  it("refuses unknown niches and niches without collected videos honestly", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "niche-export-tool-"));
    dirs.push(exportDir);
    const { client, db } = await connect({ dataDir: exportDir });
    const untracked = await client.callTool({
      name: "niche_export",
      arguments: { name: "nope", format: "csv" },
    });
    expect(textOf(untracked)).toContain("is not tracked");
    db.addNiche("empty");
    const empty = await client.callTool({
      name: "niche_export",
      arguments: { name: "empty", format: "csv" },
    });
    expect(textOf(empty)).toContain("No videos collected");
  });

  it("reports missing host wiring instead of writing nowhere", async () => {
    const { client, db } = await connect();
    db.addNiche("any");
    const result = await client.callTool({
      name: "niche_export",
      arguments: { name: "any", format: "csv" },
    });
    expect(textOf(result)).toContain("data directory");
  });
});
