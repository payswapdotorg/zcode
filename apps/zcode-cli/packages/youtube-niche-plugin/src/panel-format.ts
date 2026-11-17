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
} as const;

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
