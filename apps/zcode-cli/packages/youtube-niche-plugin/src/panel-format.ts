import type { NicheRecord } from "#niche/contract.ts";

/**
 * Bilingual labels and DOM-free formatting helpers for the Niche Explorer
 * panel. Kept pure so the panel bundle stays thin and the wording stays
 * unit-testable in a plain node environment.
 */
export const PANEL_TEXT = {
  title: "Niche Explorer · 细分领域探索",
  empty: "还没有追踪的细分领域。",
  emptyHint: "No niches tracked yet — ask the agent to use niche_add.",
  loadFailed: "面板加载失败",
  quotaLabel: "今日配额",
  connectPrompt: "YouTube 待授权：在浏览器打开以下链接完成同意，然后让 agent 调用 youtube_connect_finish。",
  videosEmpty: "该领域还没有采集到视频（等待 R2 后由 niche_collect 填充）。",
  videosFailed: "视频明细加载失败",
  channelsTitle: "频道榜 · Channel leaders",
  compareTitle: "跨领域对比 · Niche comparison",
  exportLabel: "导出 CSV",
  reportLabel: "导出周报",
  exportDone: "已导出",
  exportFailed: "导出失败",
} as const;

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
}

export function formatQuota(quota: QuotaInfo): string {
  return `${PANEL_TEXT.quotaLabel} ${quota.used} / ${quota.limit}（剩余 ${quota.remaining}）`;
}

/** Score bar width: clamp to 0..1 (ranked scores live there, be safe anyway). */
export function scoreBarWidth(score: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  return `${Math.round(clamped * 100)}%`;
}

const formatPerDay = (value: number): string =>
  value >= 100 ? Math.round(value).toLocaleString("en-US") : String(Math.round(value * 10) / 10);

export interface RankedRow {
  rank: string;
  title: string;
  viewsPerDay: string;
  barWidth: string;
  /** Trend badge glyph joined from niche_trends ("—" when unknown). */
  trend: string;
  /** CSS class for the badge (trend-accelerating / steady / cooling / insufficient). */
  trendClass: string;
}

/** Badge glyph per momentum classification; anything unknown stays honest. */
export function trendBadge(trend: unknown): string {
  if (trend === "accelerating") return "↗";
  if (trend === "steady") return "→";
  if (trend === "cooling") return "↘";
  return "—";
}

export function trendClassOf(trend: unknown): string {
  if (trend === "accelerating" || trend === "steady" || trend === "cooling") {
    return `trend-${trend}`;
  }
  return "trend-insufficient";
}

/** Rows for the ranked video table (niche_rank output joined with niche_trends). */
export function rankedVideoRows(
  ranked: ReadonlyArray<{
    video: { title?: unknown; video_id?: unknown };
    viewsPerDay?: unknown;
    score?: unknown;
  }>,
  trends?: ReadonlyArray<{ video_id?: unknown; trend?: unknown }>,
): RankedRow[] {
  const trendByVideo = new Map(
    (trends ?? []).map((row) => [String(row.video_id ?? ""), row.trend]),
  );
  return ranked.map((row, index) => {
    const trend = trendByVideo.get(String(row.video.video_id ?? ""));
    return {
      rank: String(index + 1),
      title: String(row.video.title ?? ""),
      viewsPerDay: `${formatPerDay(Number(row.viewsPerDay) || 0)}/day`,
      barWidth: scoreBarWidth(Number(row.score) || 0),
      trend: trendBadge(trend),
      trendClass: trendClassOf(trend),
    };
  });
}

export interface ChannelRow {
  title: string;
  meta: string;
  barWidth: string;
}

/** Rows for the channel leaderboard (niche_channels structured output, read structurally). */
export function channelRows(
  channels: ReadonlyArray<{
    title?: unknown;
    channelId?: unknown;
    videoCount?: unknown;
    totalViews?: unknown;
    score?: unknown;
  }>,
): ChannelRow[] {
  return channels.map((channel) => ({
    title: String(channel.title ?? channel.channelId ?? "unknown"),
    meta: `${Number(channel.videoCount) || 0} 视频 · ${(Number(channel.totalViews) || 0).toLocaleString("en-US")} views`,
    barWidth: scoreBarWidth(Number(channel.score) || 0),
  }));
}

export interface ComparisonRow {
  name: string;
  meta: string;
  momentum: string;
  heat: string;
  barWidth: string;
}

/**
 * Rows for the cross-niche comparison table (niche_compare structured
 * output, read structurally): zero momentum buckets are omitted, heat stays
 * "—" until a video classifies.
 */
export function comparisonRows(
  comparison: ReadonlyArray<{
    niche?: unknown;
    videoCount?: unknown;
    totalViews?: unknown;
    accelerating?: unknown;
    steady?: unknown;
    cooling?: unknown;
    insufficient?: unknown;
    heat?: unknown;
    score?: unknown;
  }>,
): ComparisonRow[] {
  return comparison.map((row) => {
    const name =
      typeof row.niche === "string"
        ? row.niche
        : String((row.niche as { name?: unknown } | null)?.name ?? "");
    const counts: ReadonlyArray<readonly [number, string]> = [
      [Number(row.accelerating) || 0, "↗"],
      [Number(row.steady) || 0, "→"],
      [Number(row.cooling) || 0, "↘"],
      [Number(row.insufficient) || 0, "—"],
    ];
    const parts = counts
      .filter(([count]) => count > 0)
      .map(([count, glyph]) => `${count}${glyph}`);
    const heat = Number(row.heat);
    return {
      name,
      meta: `${Number(row.videoCount) || 0} 视频 · ${(Number(row.totalViews) || 0).toLocaleString("en-US")} views`,
      momentum: parts.length ? parts.join(" ") : "—",
      heat: Number.isFinite(heat) && row.heat != null ? `热度 ${Math.round(heat * 100)}%` : "—",
      barWidth: scoreBarWidth(Number(row.score) || 0),
    };
  });
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

export function formatNicheMeta(niche: NicheRecord): string {
  return `channels: ${niche.channel_count} · videos: ${niche.video_count} · ${formatDate(niche.created_at)}`;
}

export interface NicheItem {
  name: string;
  notes: string;
  meta: string;
}

export function nicheItems(niches: readonly NicheRecord[]): NicheItem[] {
  return niches.map((niche) => ({
    name: niche.name,
    notes: niche.notes,
    meta: formatNicheMeta(niche),
  }));
}
