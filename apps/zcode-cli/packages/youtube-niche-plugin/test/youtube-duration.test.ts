import { describe, expect, it } from "vitest";
import { parseISODuration } from "#niche/youtube/duration.ts";

describe("parseISODuration", () => {
  it("converts YouTube durations to seconds", () => {
    expect(parseISODuration("PT45S")).toBe(45);
    expect(parseISODuration("PT2M30S")).toBe(150);
    expect(parseISODuration("PT1H2M3S")).toBe(3723);
    expect(parseISODuration("P1DT2H")).toBe(93600);
  });

  it("returns null for live streams and malformed input", () => {
    expect(parseISODuration("PT0S")).toBeNull();
    expect(parseISODuration("P")).toBeNull();
    expect(parseISODuration("garbage")).toBeNull();
    expect(parseISODuration("")).toBeNull();
    expect(parseISODuration(null)).toBeNull();
    expect(parseISODuration(undefined)).toBeNull();
  });
});
