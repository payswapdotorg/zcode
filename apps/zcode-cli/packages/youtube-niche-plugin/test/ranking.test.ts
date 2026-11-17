import { describe, expect, it } from "vitest";
import type { NicheRecord, VideoRecord } from "#niche/contract.ts";
import {
  RANKING_WEIGHTS,
  daysSince,
  describeRanking,
  engagementRate,
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
