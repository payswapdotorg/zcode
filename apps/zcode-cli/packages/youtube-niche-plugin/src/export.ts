import { mkdirSync, writeFileSync } from "node:fs";
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
