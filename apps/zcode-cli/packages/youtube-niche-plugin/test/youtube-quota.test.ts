import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_QUOTA,
  QUOTA_UNIT_COSTS,
  QuotaExceededError,
  quotaDayKey,
  readLedger,
  recordUsage,
  type QuotaKv,
} from "#niche/youtube/quota.ts";

const kv = (): QuotaKv => {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
  };
};

describe("quotaDayKey", () => {
  it("bucketizes by Pacific calendar day, not UTC", () => {
    // 07:30 UTC on the 17th is still 23:30 on the 16th in PST (UTC-8).
    expect(quotaDayKey(new Date("2026-11-17T07:30:00Z"))).toBe("2026-11-16");
    expect(quotaDayKey(new Date("2026-11-17T09:00:00Z"))).toBe("2026-11-17");
  });
});

describe("ledger", () => {
  it("starts at zero with the default limit and counts real unit costs", () => {
    const store = kv();
    const now = new Date("2026-11-17T10:00:00Z");
    expect(readLedger(store, now)).toEqual({ day: "2026-11-17", used: 0, limit: DEFAULT_DAILY_QUOTA });

    recordUsage(store, "videos.list", now, 50);
    recordUsage(store, "search.list", now);
    expect(readLedger(store, now)).toEqual({
      day: "2026-11-17",
      used: 50 * QUOTA_UNIT_COSTS["videos.list"] + QUOTA_UNIT_COSTS["search.list"],
      limit: DEFAULT_DAILY_QUOTA,
    });
  });

  it("resets the counter when the Pacific day rolls over", () => {
    const store = kv();
    recordUsage(store, "search.list", new Date("2026-11-17T10:00:00Z"));
    const nextDay = readLedger(store, new Date("2026-11-18T10:00:00Z"));
    expect(nextDay.used).toBe(0);
    expect(nextDay.day).toBe("2026-11-18");
  });

  it("refuses calls that would exceed the daily budget", () => {
    const store = kv();
    const now = new Date("2026-11-17T10:00:00Z");
    // 100 searches = the whole default budget.
    recordUsage(store, "search.list", now, 100);
    expect(() => recordUsage(store, "videos.list", now)).toThrow(QuotaExceededError);
    try {
      recordUsage(store, "search.list", now);
    } catch (error) {
      expect(error).toBeInstanceOf(QuotaExceededError);
      expect((error as QuotaExceededError).message).toContain("Pacific-midnight reset");
    }
  });
});
