import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NicheRecord } from "#niche/contract.ts";
import type { NicheDatabase } from "#niche/db.ts";
import {
  COMPARE_WEIGHTS,
  MOMENTUM_THRESHOLDS,
  RANKING_WEIGHTS,
  compareNiches,
  computeMomentum,
  rankChannels,
  rankVideos,
  type NicheComparison,
  type NicheComparisonInput,
  type ScoredChannel,
  type ScoredVideo,
  type VideoMomentum,
} from "#niche/ranking.ts";

/**
 * Offline export of a niche's collected videos to CSV (RFC 4180), plain
 * Markdown, or a full Markdown report (ranked videos with trends, channel
 * leaderboard, cross-niche position), enriched with the same ranking the
 * niche_rank tool uses (views/day, engagement rate, normalized score). Files
 * land in `<dataDir>/exports/` with a sanitized niche slug — minute-precision
 * timestamps keep re-exports of the same niche idempotent instead of littering
 * the directory.
 */
export type ExportFormat = "csv" | "markdown" | "report";

const CSV_COLUMNS = [
  "rank",
  "video_id",
  "title",
  "channel_id",
  "published_at",
  "view_count",
  "like_count",
  "comment_count",
  "duration_seconds",
  "views_per_day",
  "engagement_rate",
  "score",
] as const;

/** RFC 4180: quote separators/quotes/newlines, double inner quotes. */
function csvCell(value: string | number | null): string {
  const raw = value == null ? "" : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

export function toCsv(rows: readonly ScoredVideo[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  rows.forEach((row, index) => {
    const { video, viewsPerDay, engagementRate, score } = row;
    lines.push(
      [
        index + 1,
        video.video_id,
        video.title,
        video.channel_id ?? "",
        video.published_at ?? "",
        video.view_count ?? "",
        video.like_count ?? "",
        video.comment_count ?? "",
        video.duration_seconds ?? "",
        Math.round(viewsPerDay),
        engagementRate.toFixed(4),
        score.toFixed(4),
      ]
        .map(csvCell)
        .join(","),
    );
  });
  return `${lines.join("\n")}\n`;
}

/** Markdown tables have no quoting: escape pipes, flatten newlines. */
function mdCell(value: string | number | null): string {
  if (value == null || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

export function toMarkdown(niche: NicheRecord, rows: readonly ScoredVideo[], now: Date): string {
  const lines = [
    `# ${niche.name} — collected videos`,
    "",
    `Exported ${now.toISOString()} · ${rows.length} videos · score = ${RANKING_WEIGHTS.velocity}·views/day + ${RANKING_WEIGHTS.engagement}·engagement (normalized within the batch)`,
    "",
    "| # | title | channel | published | views | likes | comments | views/day | score |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  rows.forEach((row, index) => {
    const { video, viewsPerDay, score } = row;
    const cells = [
      index + 1,
      video.title,
      video.channel_id ?? "",
      video.published_at?.slice(0, 10) ?? "",
      video.view_count ?? "",
      video.like_count ?? "",
      video.comment_count ?? "",
      Math.round(viewsPerDay),
      score.toFixed(4),
    ].map(mdCell);
    lines.push(`| ${cells.join(" | ")} |`);
  });
  return `${lines.join("\n")}\n`;
}

/** Filesystem-safe niche slug: keep letters/digits (unicode), dash-separate the rest. */
export function slugifyNiche(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\p{P}\p{S}\p{Z}\p{C}]+/gu, "-")
    .replace(/[^-\p{L}\p{N}]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (slug || "niche").slice(0, 40);
}

function exportStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 16).replaceAll(":", "")}`;
}

export type ExportResult =
  | { ok: true; path: string; rows: number; bytes: number }
  | { ok: false; reason: string };

export function exportNiche(opts: {
  db: NicheDatabase;
  niche: NicheRecord;
  format: ExportFormat;
  limit?: number;
  dataDir: string;
  now?: Date;
}): ExportResult {
  const now = opts.now ?? new Date();
  const videos = opts.db.listVideos(opts.niche.id);
  if (!videos.length) {
    return {
      ok: false,
      reason: `No videos collected for "${opts.niche.name}" yet; niche_export fills after niche_collect runs with API credentials (R2).`,
    };
  }
  const ranked = rankVideos(videos, now).slice(0, opts.limit ?? 200);
  const content =
    opts.format === "csv"
      ? toCsv(ranked)
      : opts.format === "markdown"
        ? toMarkdown(opts.niche, ranked, now)
        : toReport({
            niche: opts.niche,
            ranked,
            momentum: computeMomentum(videos, opts.db.listVideoStats(opts.niche.id), now),
            channels: rankChannels(videos, now),
            comparison: comparisonAcrossNiches(opts.db, now),
            now,
          });
  const dir = join(opts.dataDir, "exports");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `niche-${slugifyNiche(opts.niche.name)}${opts.format === "report" ? "-report" : ""}-${exportStamp(now)}.${opts.format === "csv" ? "csv" : "md"}`,
  );
  writeFileSync(path, content, "utf8");
  return { ok: true, path, rows: ranked.length, bytes: Buffer.byteLength(content, "utf8") };
}

/** Cross-niche comparison over every tracked niche; empty until two exist. */
function comparisonAcrossNiches(db: NicheDatabase, now: Date): NicheComparison[] {
  const niches = db.listNiches();
  if (niches.length < 2) return [];
  const inputs: NicheComparisonInput[] = niches.map((niche) => ({
    niche,
    videos: db.listVideos(niche.id),
    stats: db.listVideoStats(niche.id),
  }));
  return compareNiches(inputs, now);
}

/** Trend cell for the report table: class plus ratio when one exists. */
function trendCell(row: VideoMomentum): string {
  return row.ratio != null ? `${row.trend} ${row.ratio.toFixed(1)}×` : row.trend;
}

/**
 * Full Markdown report for one niche: momentum summary, ranked videos with a
 * trend column, the channel leaderboard and the cross-niche position — the
 * one artifact an owner can archive per niche instead of three exports.
 */
export function toReport(opts: {
  niche: NicheRecord;
  ranked: readonly ScoredVideo[];
  momentum: readonly VideoMomentum[];
  channels: readonly ScoredChannel[];
  comparison: readonly NicheComparison[];
  now: Date;
}): string {
  const trends = new Map(opts.momentum.map((row) => [row.video.video_id, row]));
  const counts = new Map<string, number>();
  for (const row of opts.momentum) counts.set(row.trend, (counts.get(row.trend) ?? 0) + 1);
  const lines = [
    `# ${opts.niche.name} — niche report`,
    "",
    `Exported ${opts.now.toISOString()} · ${opts.ranked.length} videos · score = ${RANKING_WEIGHTS.velocity}·views/day + ${RANKING_WEIGHTS.engagement}·engagement (normalized within the niche)`,
    "",
    "## Momentum",
    "",
    `${counts.get("accelerating") ?? 0} accelerating · ${counts.get("steady") ?? 0} steady · ${counts.get("cooling") ?? 0} cooling · ${counts.get("insufficient") ?? 0} insufficient (≥${MOMENTUM_THRESHOLDS.accelerating}× accelerating, ≤${MOMENTUM_THRESHOLDS.cooling}× cooling)`,
    "",
    "## Ranked videos",
    "",
    "| # | title | channel | published | views | views/day | trend | score |",
    "|---|---|---|---|---|---|---|---|",
  ];
  opts.ranked.forEach((row, index) => {
    const { video, viewsPerDay, score } = row;
    const trend = trends.get(video.video_id);
    const cells = [
      index + 1,
      video.title,
      video.channel_id ?? "",
      video.published_at?.slice(0, 10) ?? "",
      video.view_count ?? "",
      Math.round(viewsPerDay),
      trend ? trendCell(trend) : "insufficient",
      score.toFixed(4),
    ].map(mdCell);
    lines.push(`| ${cells.join(" | ")} |`);
  });
  lines.push("", "## Top channels", "", "| # | channel | videos | total views | views/day | engagement | score |", "|---|---|---|---|---|---|---|");
  opts.channels.forEach((row, index) => {
    const cells = [
      index + 1,
      row.title ?? row.channelId ?? "unknown",
      row.videoCount,
      row.totalViews,
      Math.round(row.viewsPerDay),
      `${(row.engagementRate * 100).toFixed(1)}%`,
      row.score.toFixed(4),
    ].map(mdCell);
    lines.push(`| ${cells.join(" | ")} |`);
  });
  lines.push("", "## Cross-niche position", "");
  const position = opts.comparison.findIndex((row) => row.niche.id === opts.niche.id);
  if (position === -1) {
    lines.push("Only this niche is tracked — the cross-niche position appears once other niches are added.");
  } else {
    const row = opts.comparison[position]!;
    const leader = opts.comparison[0]!;
    lines.push(
      `**#${position + 1} of ${opts.comparison.length}** tracked niches by composite score (${row.score.toFixed(2)}; leader "${leader.niche.name}" at ${leader.score.toFixed(2)}, weights ${COMPARE_WEIGHTS.velocity}·velocity + ${COMPARE_WEIGHTS.engagement}·engagement + ${COMPARE_WEIGHTS.momentum}·momentum).`,
    );
    lines.push(
      row.heat == null
        ? "Heat: no classified videos yet."
        : `Heat: ${(row.heat * 100).toFixed(0)}% accelerating share.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const COMPARE_CSV_COLUMNS = [
  "rank",
  "niche",
  "video_count",
  "total_views",
  "views_per_day",
  "engagement_rate",
  "accelerating",
  "steady",
  "cooling",
  "insufficient",
  "heat",
  "score",
] as const;

export function comparisonToCsv(comparison: readonly NicheComparison[]): string {
  const lines = [COMPARE_CSV_COLUMNS.join(",")];
  comparison.forEach((row, index) => {
    lines.push(
      [
        index + 1,
        row.niche.name,
        row.videoCount,
        row.totalViews,
        Math.round(row.viewsPerDay),
        row.engagementRate.toFixed(4),
        row.accelerating,
        row.steady,
        row.cooling,
        row.insufficient,
        row.heat == null ? "" : row.heat.toFixed(4),
        row.score.toFixed(4),
      ]
        .map(csvCell)
        .join(","),
    );
  });
  return `${lines.join("\n")}\n`;
}

export function comparisonToMarkdown(
  comparison: readonly NicheComparison[],
  now: Date,
): string {
  const lines = [
    "# Cross-niche comparison",
    "",
    `Exported ${now.toISOString()} · ${comparison.length} niches · score = ${COMPARE_WEIGHTS.velocity}·views/day avg + ${COMPARE_WEIGHTS.engagement}·engagement + ${COMPARE_WEIGHTS.momentum}·accelerating share (velocity/engagement normalized across niches)`,
    "",
    "| # | niche | videos | total views | views/day | engagement | ↗ | → | ↘ | — | heat | score |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  comparison.forEach((row, index) => {
    const cells = [
      index + 1,
      row.niche.name,
      row.videoCount,
      row.totalViews,
      Math.round(row.viewsPerDay),
      `${(row.engagementRate * 100).toFixed(1)}%`,
      row.accelerating,
      row.steady,
      row.cooling,
      row.insufficient,
      row.heat == null ? "—" : row.heat.toFixed(2),
      row.score.toFixed(4),
    ].map(mdCell);
    lines.push(`| ${cells.join(" | ")} |`);
  });
  const movers = comparison.filter((row) => row.topMover);
  if (movers.length) {
    lines.push("", "## Top movers", "");
    for (const row of movers) {
      const mover = row.topMover!;
      lines.push(
        `- **${row.niche.name}**: ${mover.title} (${mover.trend}${mover.ratio != null ? `, ${mover.ratio.toFixed(1)}×` : ""})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Offline export of the cross-niche comparison (the niche_compare view) to CSV
 * or Markdown. Needs at least two tracked niches — a one-niche comparison is
 * meaningless; niches without collected videos still appear with honest zeros.
 */
export function exportComparison(opts: {
  db: NicheDatabase;
  format: ExportFormat;
  limit?: number;
  dataDir: string;
  now?: Date;
}): ExportResult {
  const now = opts.now ?? new Date();
  const niches = opts.db.listNiches();
  if (niches.length < 2) {
    return {
      ok: false,
      reason: `Comparison export needs at least 2 tracked niches (currently ${niches.length}); niche_add more niches first.`,
    };
  }
  const inputs: NicheComparisonInput[] = niches.map((niche) => ({
    niche,
    videos: opts.db.listVideos(niche.id),
    stats: opts.db.listVideoStats(niche.id),
  }));
  const comparison = compareNiches(inputs, now).slice(0, opts.limit ?? 20);
  const content =
    opts.format === "csv" ? comparisonToCsv(comparison) : comparisonToMarkdown(comparison, now);
  const dir = join(opts.dataDir, "exports");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `niche-compare-${exportStamp(now)}.${opts.format === "csv" ? "csv" : "md"}`,
  );
  writeFileSync(path, content, "utf8");
  return { ok: true, path, rows: comparison.length, bytes: Buffer.byteLength(content, "utf8") };
}

// ── Scheduled exports ───────────────────────────────────────────────────────

/** How long to wait between scheduled report runs (checked hourly by the server). */
export const SCHEDULED_EXPORT_INTERVAL_HOURS = 24;

/** Marker file (dataDir root) remembering the last scheduled run. */
const SCHEDULE_MARKER_FILE = "schedule.json";

export interface ScheduleMarker {
  lastRun: string | null;
}

/** Reads the schedule marker; a missing or corrupt file counts as "never ran". */
export function readScheduleMarker(dataDir: string): ScheduleMarker {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, SCHEDULE_MARKER_FILE), "utf8")) as {
      lastRun?: unknown;
    };
    return typeof parsed.lastRun === "string" ? { lastRun: parsed.lastRun } : { lastRun: null };
  } catch {
    return { lastRun: null };
  }
}

/** True when no run happened yet, the interval elapsed, or the marker date is garbage. */
export function shouldRunScheduledExports(
  marker: ScheduleMarker,
  now: Date,
  intervalHours: number = SCHEDULED_EXPORT_INTERVAL_HOURS,
): boolean {
  if (!marker.lastRun) return true;
  const elapsed = now.getTime() - new Date(marker.lastRun).getTime();
  return !Number.isFinite(elapsed) || elapsed >= intervalHours * 60 * 60 * 1000;
}

export type ScheduledExportResult = {
  ok: true;
  /** Reports written this run, one per niche with collected videos. */
  written: { niche: string; path: string }[];
  /** Tracked niches without collected videos — nothing to report yet. */
  skipped: string[];
  /** Files removed by retention pruning this pass. */
  pruned: string[];
};

/** How many files each export group keeps after pruning. */
export const SCHEDULED_EXPORT_RETENTION = 30;

/**
 * Export filename patterns → retention groups. Order matters: report and
 * compare names also match the plain csv/md patterns with a longer slug, so
 * they must be tried first.
 */
const EXPORT_PATTERNS = [
  { re: /^niche-(?<slug>.+)-report-(?<stamp>\d{8}-\d{4})\.md$/, kind: "report" },
  { re: /^niche-compare-(?<stamp>\d{8}-\d{4})\.(?<ext>csv|md)$/, kind: "compare" },
  { re: /^niche-(?<slug>.+)-(?<stamp>\d{8}-\d{4})\.csv$/, kind: "csv" },
  { re: /^niche-(?<slug>.+)-(?<stamp>\d{8}-\d{4})\.md$/, kind: "md" },
] as const;

/**
 * Prunes the exports directory: keeps the newest `keep` files per group
 * (report:niche, csv:niche, md:niche, compare:format) and deletes the rest.
 * Files the plugin did not write are never touched; a missing directory and
 * individual delete failures are tolerated silently — retention is
 * housekeeping, not a gate.
 */
export function pruneExports(opts: { exportsDir: string; keep?: number }): { deleted: string[] } {
  const keep = opts.keep ?? SCHEDULED_EXPORT_RETENTION;
  let names: string[];
  try {
    names = readdirSync(opts.exportsDir);
  } catch {
    return { deleted: [] };
  }
  const groups = new Map<string, string[]>();
  for (const name of names) {
    for (const { re, kind } of EXPORT_PATTERNS) {
      const fields = re.exec(name)?.groups;
      if (!fields) continue;
      const slug = fields.slug ?? "";
      const ext = fields.ext ?? "";
      const key =
        kind === "compare"
          ? `compare:${ext}`
          : kind === "report"
            ? `report:${slug}`
            : `${kind}:${slug}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(name);
      else groups.set(key, [name]);
      break;
    }
  }
  const deleted: string[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => b.localeCompare(a)); // stamps sort lexicographically
    for (const name of bucket.slice(keep)) {
      try {
        unlinkSync(join(opts.exportsDir, name));
        deleted.push(name);
      } catch {
        // A locked file is skipped; the next pass retries.
      }
    }
  }
  // Ascending order keeps the deleted list deterministic and chronological.
  return { deleted: deleted.sort((a, b) => a.localeCompare(b)) };
}

/**
 * One scheduled export pass: a Markdown report for every niche with collected
 * videos, then a retention prune so the exports directory stays bounded. The
 * marker only advances when at least one report was written, so a day without
 * data does not delay the next real report.
 */
export function runScheduledExports(opts: {
  db: NicheDatabase;
  dataDir: string;
  now?: Date;
}): ScheduledExportResult {
  const now = opts.now ?? new Date();
  const written: { niche: string; path: string }[] = [];
  const skipped: string[] = [];
  for (const niche of opts.db.listNiches()) {
    if (!opts.db.listVideos(niche.id).length) {
      skipped.push(niche.name);
      continue;
    }
    const result = exportNiche({
      db: opts.db,
      niche,
      format: "report",
      dataDir: opts.dataDir,
      now,
    });
    if (result.ok) written.push({ niche: niche.name, path: result.path });
  }
  if (written.length)
    writeFileSync(
      join(opts.dataDir, SCHEDULE_MARKER_FILE),
      `${JSON.stringify({ lastRun: now.toISOString() }, null, 2)}\n`,
      "utf8",
    );
  const { deleted: pruned } = pruneExports({ exportsDir: join(opts.dataDir, "exports") });
  return { ok: true, written, skipped, pruned };
}
