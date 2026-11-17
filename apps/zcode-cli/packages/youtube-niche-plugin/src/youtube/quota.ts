/**
 * YouTube Data API v3 quota ledger. Quota days run to midnight Pacific Time
 * and the default project budget is 10,000 units/day; search.list is the
 * expensive call (100 units) while videos.list/channels.list cost 1 unit —
 * the collector must therefore prefer targeted reads over repeated searches.
 * The ledger is a thin kv-backed counter so the collection client (phase 3)
 * can refuse quota-breaking batches before spending them.
 */
export const QUOTA_UNIT_COSTS = {
  "search.list": 100,
  "videos.list": 1,
  "channels.list": 1,
} as const;

export type QuotaMethod = keyof typeof QUOTA_UNIT_COSTS;

export const DEFAULT_DAILY_QUOTA = 10000;

export class QuotaExceededError extends Error {
  constructor(
    readonly ledger: QuotaLedger,
    readonly method: QuotaMethod,
  ) {
    super(
      `YouTube quota: ${method} would need ${ledger.used + QUOTA_UNIT_COSTS[method]} of ${ledger.limit} units on ${ledger.day}; wait for the Pacific-midnight reset`,
    );
    this.name = "QuotaExceededError";
  }
}

export interface QuotaLedger {
  /** Pacific-Time calendar day (YYYY-MM-DD) this counter belongs to. */
  day: string;
  used: number;
  limit: number;
}

export interface QuotaKv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const USED_KEY = "youtube_quota_used";
const DAY_KEY = "youtube_quota_day";
const LIMIT_KEY = "youtube_quota_limit";

/** The quota day as a YYYY-MM-DD key in America/Los_Angeles. */
export function quotaDayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function readLedger(kv: QuotaKv, now: Date): QuotaLedger {
  const day = quotaDayKey(now);
  const limit = Number(kv.get(LIMIT_KEY)) || DEFAULT_DAILY_QUOTA;
  // A new Pacific day resets the counter.
  const used = kv.get(DAY_KEY) === day ? Number(kv.get(USED_KEY)) || 0 : 0;
  return { day, used, limit };
}

/** Records one API call (or a batch of `units` calls) and persists the ledger. */
export function recordUsage(kv: QuotaKv, method: QuotaMethod, now: Date, units = 1): QuotaLedger {
  const ledger = readLedger(kv, now);
  const cost = QUOTA_UNIT_COSTS[method] * units;
  if (ledger.used + cost > ledger.limit) throw new QuotaExceededError(ledger, method);
  ledger.used += cost;
  kv.set(DAY_KEY, ledger.day);
  kv.set(USED_KEY, String(ledger.used));
  return ledger;
}
