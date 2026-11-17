import { describe, expect, it } from "vitest";
import type { NicheRecord } from "#niche/contract.ts";
import { PANEL_TEXT, formatDate, formatNicheMeta, nicheItems } from "#niche/panel-format.ts";

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
