import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readScheduleMarker } from "#niche/export.ts";
import { YouTubeClient, type FetchLike } from "#niche/youtube/client.ts";
import { makeConnect } from "./support/connect.ts";

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const connect = makeConnect(closers, dirs);

describe("scheduled exports wiring", () => {
  it("writes reports automatically shortly after startup", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "niche-schedule-tool-"));
    dirs.push(exportDir);
    const { db } = await connect({
      dataDir: exportDir,
      // The first tick may fire before the seed below lands; the 100ms
      // re-check guarantees a tick sees the data regardless of connect timing.
      exportScheduler: { startupDelayMs: 10, checkIntervalMs: 100 },
    });
    // Seed after connect: the scheduler must pick up what exists at tick time.
    const espresso = db.addNiche("espresso");
    db.addVideo(espresso.id, {
      video_id: "v1",
      title: "Heating up",
      channel_id: "c1",
      published_at: "2026-11-01T00:00:00Z",
      view_count: 10000,
      like_count: 10,
      comment_count: 1,
      duration_seconds: 60,
      collected_at: "2026-11-17T00:00:00Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(readScheduleMarker(exportDir).lastRun).toBeTruthy();
    const files = readdirSync(join(exportDir, "exports"));
    expect(files.some((name) => /^niche-espresso-report-\d{8}-\d{4}\.md$/.test(name))).toBe(true);
    const report = readFileSync(
      join(exportDir, "exports", files.find((name) => name.endsWith(".md"))!),
      "utf8",
    );
    expect(report).toContain("# espresso — niche report");
  });
});

describe("scheduled collection wiring", () => {
  it("collects automatically shortly after startup when a client exists", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "niche-collect-tool-"));
    dirs.push(exportDir);
    const kv = new Map<string, string>();
    // A fresh stateless fixture: a stateful shared fixture would be exhausted
    // by earlier test files before this tick fires.
    const freshFetch: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/search"))
        return { status: 200, json: async () => ({ items: [{ id: { videoId: "v1" }, snippet: { channelId: "c1" } }] }) };
      if (path.endsWith("/videos"))
        return {
          status: 200,
          json: async () => ({
            items: [
              {
                id: "v1",
                snippet: { title: "Espresso 101", channelId: "c1", publishedAt: "2026-11-10T00:00:00Z" },
                statistics: { viewCount: "5000", likeCount: "200", commentCount: "50" },
                contentDetails: { duration: "PT8M" },
              },
            ],
          }),
        };
      return { status: 200, json: async () => ({ items: [{ id: "c1", snippet: { title: "Channel One" } }] }) };
    };
    const youtube = new YouTubeClient({
      kv: { get: (key) => kv.get(key), set: (key, value) => void kv.set(key, value) },
      apiKey: "test-key",
      fetchFn: freshFetch,
    });
    const { db } = await connect({
      dataDir: exportDir,
      youtube,
      // The first tick may fire before the seed below lands; the 100ms
      // re-check guarantees a tick sees the niche. After the first run the
      // 6h guard makes further ticks no-ops, so the video count is stable.
      collectionScheduler: { startupDelayMs: 10, checkIntervalMs: 100 },
    });
    const espresso = db.addNiche("espresso");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const videos = db.listVideos(espresso.id);
    expect(videos).toHaveLength(1);
    expect(videos[0]!.video_id).toBe("v1");
  });

  it("does nothing without a YouTube client", async () => {
    const exportDir = mkdtempSync(join(tmpdir(), "niche-collect-none-"));
    dirs.push(exportDir);
    const { db, client } = await connect({
      dataDir: exportDir,
      collectionScheduler: { startupDelayMs: 10, checkIntervalMs: 100 },
    });
    const espresso = db.addNiche("espresso");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(db.listVideos(espresso.id)).toHaveLength(0);
    // The tool surface still reports the unconfigured state honestly.
    const result = (await client.callTool({ name: "niche_collect", arguments: { name: "espresso" } })) as {
      content: { text: string }[];
    };
    expect(result.content[0]!.text).toContain("credentials are not configured");
  });
});
