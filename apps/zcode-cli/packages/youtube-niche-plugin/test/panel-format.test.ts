import { describe, expect, it } from "vitest";
import type { NicheRecord } from "#niche/contract.ts";
import {
  PANEL_TEXT,
  channelRows,
  formatDate,
  formatNicheMeta,
  nicheItems,
  rankedVideoRows,
  scoreBarWidth,
  trendBadge,
  trendClassOf,
} from "#niche/panel-format.ts";

const niche = (over: Partial<NicheRecord> = {}): NicheRecord => ({
  id: 1,
  name: "budget home espresso",
  notes: "gear",
  created_at: "2026-11-17T01:02:03.000Z",
  channel_count: 2,
  video_count: 5,
  ...over,
});

describe("panel formatting", () => {
  it("formats the niche meta line with counts and date", () => {
    expect(formatNicheMeta(niche())).toBe("channels: 2 · videos: 5 · 2026-11-17");
  });

  it("keeps list order and maps display fields", () => {
    const items = nicheItems([niche({ name: "a" }), niche({ id: 2, name: "b", notes: "" })]);
    expect(items.map((item) => item.name)).toEqual(["a", "b"]);
    expect(items[1]!.notes).toBe("");
    expect(items[1]!.meta).toContain("channels: 2");
  });

  it("renders an em dash for invalid dates", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("exposes bilingual labels", () => {
    expect(PANEL_TEXT.title).toContain("Niche Explorer");
    expect(PANEL_TEXT.title).toContain("细分领域探索");
  });
});

describe("ranked view rows", () => {
  it("formats bar widths with clamping", () => {
    expect(scoreBarWidth(0)).toBe("0%");
    expect(scoreBarWidth(0.5)).toBe("50%");
    expect(scoreBarWidth(1)).toBe("100%");
    expect(scoreBarWidth(1.5)).toBe("100%");
    expect(scoreBarWidth(-0.2)).toBe("0%");
    expect(scoreBarWidth(Number.NaN)).toBe("0%");
  });

  it("maps niche_rank output into ranked table rows", () => {
    const rows = rankedVideoRows([
      { video: { title: "Fast" }, viewsPerDay: 1234.5, score: 0.62 },
      { video: { title: "Slow" }, viewsPerDay: 3.25, score: 0.04 },
    ]);
    expect(rows[0]).toEqual({
      rank: "1",
      title: "Fast",
      viewsPerDay: "1,235/day",
      barWidth: "62%",
      trend: "\u2014",
      trendClass: "trend-insufficient",
    });
    expect(rows[1]).toEqual({
      rank: "2",
      title: "Slow",
      viewsPerDay: "3.3/day",
      barWidth: "4%",
      trend: "\u2014",
      trendClass: "trend-insufficient",
    });
  });

  it("joins trend badges from niche_trends by video id", () => {
    const rows = rankedVideoRows(
      [
        { video: { title: "Hot", video_id: "a" }, viewsPerDay: 10, score: 1 },
        { video: { title: "Cold", video_id: "b" }, viewsPerDay: 5, score: 0.5 },
        { video: { title: "Flat", video_id: "c" }, viewsPerDay: 1, score: 0.2 },
      ],
      [
        { video_id: "a", trend: "accelerating" },
        { video_id: "b", trend: "cooling" },
        { video_id: "c", trend: "steady" },
      ],
    );
    expect(rows.map((row) => [row.trend, row.trendClass])).toEqual([
      ["\u2197", "trend-accelerating"],
      ["\u2198", "trend-cooling"],
      ["\u2192", "trend-steady"],
    ]);
    // ids absent from the trends list keep the honest "—"
    const partial = rankedVideoRows(
      [{ video: { title: "X", video_id: "zz" }, viewsPerDay: 1, score: 0 }],
      [{ video_id: "a", trend: "accelerating" }],
    );
    expect(partial[0]!.trend).toBe("\u2014");
  });

  it("maps trend glyphs and classes structurally", () => {
    expect(trendBadge("accelerating")).toBe("\u2197");
    expect(trendBadge("steady")).toBe("\u2192");
    expect(trendBadge("cooling")).toBe("\u2198");
    expect(trendBadge("insufficient")).toBe("\u2014");
    expect(trendBadge(undefined)).toBe("\u2014");
    expect(trendBadge("garbage")).toBe("\u2014");
    expect(trendClassOf("accelerating")).toBe("trend-accelerating");
    expect(trendClassOf("insufficient")).toBe("trend-insufficient");
    expect(trendClassOf(null)).toBe("trend-insufficient");
  });

  it("reads channel rows structurally with honest fallbacks", () => {
    const rows = channelRows([
      { title: "Channel One", channelId: "c1", videoCount: 3, totalViews: 12000, score: 0.8 },
      { channelId: "c2", videoCount: 0, totalViews: 0 },
      {},
    ]);
    expect(rows[0]).toEqual({ title: "Channel One", meta: "3 视频 · 12,000 views", barWidth: "80%" });
    expect(rows[1]!.title).toBe("c2");
    expect(rows[1]!.meta).toBe("0 视频 · 0 views");
    expect(rows[2]!.title).toBe("unknown");
    expect(PANEL_TEXT.channelsTitle).toContain("频道榜");
  });
});
