import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NicheRecord } from "#niche/contract.ts";
import type { NicheDatabase } from "#niche/db.ts";
import { RANKING_WEIGHTS, rankVideos, type ScoredVideo } from "#niche/ranking.ts";

/**
 * Offline export of a niche's collected videos to CSV (RFC 4180) or Markdown,
 * enriched with the same ranking the niche_rank tool uses (views/day,
 * engagement rate, normalized score). Files land in `<dataDir>/exports/` with
 * a sanitized niche slug — minute-precision timestamps keep re-exports of the
 * same niche idempotent instead of littering the directory.
 */
export type ExportFormat = "csv" | "markdown";

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
  const content = opts.format === "csv" ? toCsv(ranked) : toMarkdown(opts.niche, ranked, now);
  const dir = join(opts.dataDir, "exports");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `niche-${slugifyNiche(opts.niche.name)}-${exportStamp(now)}.${opts.format === "csv" ? "csv" : "md"}`,
  );
  writeFileSync(path, content, "utf8");
  return { ok: true, path, rows: ranked.length, bytes: Buffer.byteLength(content, "utf8") };
}
