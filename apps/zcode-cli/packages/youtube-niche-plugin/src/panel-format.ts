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
  exportLabel: "导出 CSV",
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

export function formatDuration(seconds: number | null): string {
  return seconds == null ? "—" : `${Math.round(seconds / 60)} min`;
}

export interface CollectedVideo {
  video_id: string;
  title: string;
  view_count: number | null;
  like_count: number | null;
  duration_seconds: number | null;
}

export interface VideoRow {
  title: string;
  views: string;
  likes: string;
  duration: string;
}

export function videoRows(videos: readonly CollectedVideo[]): VideoRow[] {
  return videos.map((video) => ({
    title: video.title,
    views: String(video.view_count ?? 0),
    likes: String(video.like_count ?? 0),
    duration: formatDuration(video.duration_seconds),
  }));
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
