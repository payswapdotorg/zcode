import { describe, expect, it } from "vitest";
import type { NicheRecord, VideoRecord, VideoStatPoint } from "#niche/contract.ts";
import {
  RANKING_WEIGHTS,
  computeMomentum,
  daysSince,
  describeChannelRanking,
  describeRanking,
  describeTrends,
  engagementRate,
  rankChannels,
  rankVideos,
  viewsPerDay,
} from "#niche/ranking.ts";

const NOW = new Date("2026-11-17T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const niche: NicheRecord = {
  id: 1,
  name: "budget home espresso",
  notes: "",
  created_at: "2026-11-01T00:00:00.000Z",
  channel_count: 0,
  video_count: 2,
};

const video = (over: Partial<VideoRecord> = {}): VideoRecord => ({
  video_id: "v1",
  title: "Video",
  channel_id: "c1",
  published_at: null,
  view_count: null,
  like_count: null,
  comment_count: null,
  duration_seconds: null,
  collected_at: "2026-11-17T00:00:00.000Z",
  ...over,
});

describe("ranking primitives", () => {
  it("computes days since publish with a one-day floor", () => {
    expect(daysSince(new Date(NOW.getTime() - 10 * DAY).toISOString(), NOW)).toBeCloseTo(10);
    expect(daysSince(new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(), NOW)).toBe(1);
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("not-a-date", NOW)).toBeNull();
  });

  it("computes views per day and engagement rate", () => {
    const published = new Date(NOW.getTime() - 10 * DAY).toISOString();
    const v = video({ view_count: 10000, like_count: 400, comment_count: 100, published_at: published });
    expect(viewsPerDay(v, NOW)).toBeCloseTo(1000);
    expect(engagementRate(v)).toBeCloseTo(0.05);
    expect(viewsPerDay(video({ view_count: 0 }), NOW)).toBeNull();
    expect(engagementRate(video({ view_count: null, like_count: 5 }))).toBeNull();
  });
});

describe("rankVideos", () => {
  it("ranks a fast riser above a slow burner on velocity", () => {
    const slow = video({
      video_id: "slow",
      title: "Slow burner",
      view_count: 10000,
      like_count: 100,
      comment_count: 0,
      published_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    });
    const fast = video({
      video_id: "fast",
      title: "Fast riser",
      view_count: 6000,
      like_count: 300,
      comment_count: 100,
      published_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    });
    const ranked = rankVideos([slow, fast], NOW);
    expect(ranked[0]!.video.video_id).toBe("fast");
    expect(ranked[0]!.viewsPerDay).toBeCloseTo(3000);
    expect(ranked[1]!.score).toBeLessThan(ranked[0]!.score);
    // fast tops both signals, so its normalized score is exactly 1;
    // slow = velocity·(1000/3000) + engagement·(0.01/(400/6000)).
    expect(ranked[0]!.score).toBeCloseTo(1);
    expect(ranked[1]!.score).toBeCloseTo(
      RANKING_WEIGHTS.velocity * (1000 / 3000) + RANKING_WEIGHTS.engagement * (0.01 / (400 / 6000)),
    );
  });

  it("keeps stat-less videos last with an explicit reason", () => {
    const ranked = rankVideos(
      [
        video({ video_id: "nul", title: "No stats" }),
        video({
          video_id: "ok",
          title: "Has stats",
          view_count: 1000,
          like_count: 50,
          comment_count: 0,
          published_at: new Date(NOW.getTime() - 5 * DAY).toISOString(),
        }),
      ],
      NOW,
    );
    expect(ranked[0]!.video.video_id).toBe("ok");
    expect(ranked[1]!.video.video_id).toBe("nul");
    expect(ranked[1]!.score).toBe(0);
    expect(ranked[1]!.reasons).toEqual(["no view data"]);
  });

  it("describes the ranking for the model", () => {
    const ranked = rankVideos(
      [
        video({
          video_id: "abc123",
          title: "Espresso on a budget",
          view_count: 2000,
          like_count: 100,
          comment_count: 20,
          published_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        }),
      ],
      NOW,
    );
    const text = describeRanking(niche, ranked);
    expect(text).toContain('Top videos for "budget home espresso"');
    expect(text).toContain("1. Espresso on a budget");
    expect(text).toContain("(abc123)");
    expect(describeRanking(niche, [])).toContain("No videos collected");
  });
});

describe("channel ranking", () => {
  const NOW = new Date("2026-11-17T00:00:00.000Z");
  const niche: NicheRecord = {
    id: 1,
    name: "espresso",
    notes: "",
    created_at: "2026-11-01T00:00:00.000Z",
    channel_count: 2,
    video_count: 3,
  };
  const day = (ago: number) => new Date(NOW.getTime() - ago * 24 * 3600 * 1000).toISOString();
  const videos: VideoRecord[] = [
    // c1: two solid videos — dominates avg views/day, moderate engagement.
    video({ video_id: "a", channel_id: "c1", view_count: 10000, like_count: 500, comment_count: 100, published_at: day(10) }),
    video({ video_id: "b", channel_id: "c1", view_count: 5000, like_count: 100, comment_count: 0, published_at: day(10) }),
    // c2: one small but hyper-engaged video.
    video({ video_id: "c", channel_id: "c2", view_count: 100, like_count: 50, comment_count: 50, published_at: day(10) }),
  ];

  it("groups, aggregates and orders channels (velocity wins at 60%)", () => {
    const ranked = rankChannels(videos, NOW);
    expect(ranked.map((row) => row.channelId)).toEqual(["c1", "c2"]);
    expect(ranked[0]).toMatchObject({
      videoCount: 2,
      totalViews: 15000,
      viewsPerDay: 750,
      title: null,
    });
    // Channel engagement pools the channel's totals: (600 likes + 100 comments) / 15000.
    expect(ranked[0]!.engagementRate).toBeCloseTo(700 / 15000, 5);
    expect(ranked[0]!.score).toBeCloseTo(
      RANKING_WEIGHTS.velocity + RANKING_WEIGHTS.engagement * (700 / 15000),
      5,
    );
    expect(ranked[1]!.engagementRate).toBeCloseTo(1, 5);
    expect(ranked[1]!.score).toBeCloseTo(
      RANKING_WEIGHTS.velocity * (10 / 750) + RANKING_WEIGHTS.engagement,
      5,
    );
  });

  it("reports per-channel reasons and pools null channel ids into one bucket", () => {
    const ranked = rankChannels(
      [...videos, video({ video_id: "d", channel_id: null, view_count: 0 })],
      NOW,
    );
    const unknown = ranked.find((row) => row.channelId === null);
    expect(unknown?.reasons).toContain("no view data");
    expect(unknown?.reasons).toContain("1 video");
    expect(ranked[0]!.reasons).toContain("750 views/day avg");
    expect(ranked[0]!.reasons).toContain("2 videos");
  });

  it("describes the leaderboard with joined titles and honest fallbacks", () => {
    const ranked = rankChannels(videos, NOW);
    ranked[0]!.title = "Channel One";
    const text = describeChannelRanking(niche, ranked);
    expect(text).toContain("Channel leaders for \"espresso\"");
    expect(text).toContain("1. Channel One — 750 views/day avg");
    expect(text).toContain("(c2)");
    expect(describeChannelRanking(niche, [])).toContain("No videos collected");
  });
});

describe("momentum", () => {
  const NOW = new Date("2026-11-17T00:00:00.000Z");
  const day = (ago: number) => new Date(NOW.getTime() - ago * 24 * 3600 * 1000).toISOString();
  const niche: NicheRecord = {
    id: 1,
    name: "espresso",
    notes: "",
    created_at: "2026-11-01T00:00:00.000Z",
    channel_count: 0,
    video_count: 3,
  };
  const point = (videoId: string, ago: number, viewCount: number): VideoStatPoint => ({
    video_id: videoId,
    snapshot_at: day(ago),
    view_count: viewCount,
    like_count: null,
    comment_count: null,
  });
  const videos: VideoRecord[] = [
    // lifetime 10/day; snapshots say 37.5/day over the last 8 days → 3.75×.
    video({ video_id: "hot", title: "Hot", view_count: 1000, published_at: day(100) }),
    // lifetime 100/day, recent 100/day → steady.
    video({ video_id: "flat", title: "Flat", view_count: 5000, published_at: day(50) }),
    // lifetime 1000/day, recent 25/day → cooling.
    video({ video_id: "cold", title: "Cold", view_count: 100000, published_at: day(100) }),
  ];
  const stats: VideoStatPoint[] = [
    point("hot", 10, 100),
    point("hot", 2, 400),
    point("flat", 10, 4200),
    point("flat", 2, 5000),
    point("cold", 10, 99800),
    point("cold", 2, 100000),
  ];

  it("classifies accelerating / steady / cooling and sorts by momentum", () => {
    const rows = computeMomentum(videos, stats, NOW);
    expect(rows.map((row) => row.trend)).toEqual(["accelerating", "steady", "cooling"]);
    expect(rows[0]).toMatchObject({ recentVpd: 37.5, ratio: 3.75 });
    expect(rows[0]!.lifetimeVpd).toBeCloseTo(10, 5);
    expect(rows[1]!.ratio).toBeCloseTo(1, 5);
    expect(rows[2]!.ratio).toBeCloseTo(0.025, 5);
  });

  it("reports insufficient for short windows, single snapshots and no view data", () => {
    const rows = computeMomentum(
      [video({ video_id: "short", title: "Short", view_count: 500, published_at: day(10) })],
      [point("short", 0.25, 100), point("short", 0, 500)],
      NOW,
    );
    expect(rows[0]!.trend).toBe("insufficient");
    expect(rows[0]!.ratio).toBeNull();
    const single = computeMomentum(
      [video({ video_id: "once", title: "Once", view_count: 500, published_at: day(10) })],
      [point("once", 5, 500)],
      NOW,
    );
    expect(single[0]!.trend).toBe("insufficient");
    // Stat points without view data never enter the series.
    const noData = computeMomentum(
      [video({ video_id: "bare", title: "Bare", view_count: null, published_at: day(10) })],
      [{ video_id: "bare", snapshot_at: day(5), view_count: null, like_count: null, comment_count: null }],
      NOW,
    );
    expect(noData[0]!.trend).toBe("insufficient");
    expect(noData[0]!.reasons).toContain("needs ≥2 collections ≥1 day apart");
  });

  it("describes the trend report with counts and momentum lines", () => {
    const rows = computeMomentum(videos, stats, NOW);
    const text = describeTrends(niche, rows);
    expect(text).toContain("Trend report for \"espresso\"");
    expect(text).toContain("1 accelerating · 1 steady · 1 cooling · 0 insufficient");
    expect(text).toContain("1. Hot — accelerating: lifetime 10/day → recent 38/day (3.8×)");
    expect(describeTrends(niche, [])).toContain("No videos collected");
  });
});
