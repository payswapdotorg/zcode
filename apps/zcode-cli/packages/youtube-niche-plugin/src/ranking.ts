import type { NicheRecord, VideoRecord } from "#niche/contract.ts";

/**
 * Local ranking for collected videos — no network, no API: the score is a
 * min-max normalized blend of view velocity (views per day since publish) and
 * engagement rate ((likes + comments) / views). Missing stats never throw;
 * they simply drop that signal and surface the reason.
 */
export const RANKING_WEIGHTS = { velocity: 0.6, engagement: 0.4 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScoredVideo {
  video: VideoRecord;
  viewsPerDay: number;
  engagementRate: number;
  /** 0..1 within the ranked batch. */
  score: number;
  reasons: string[];
}

export function daysSince(publishedAt: string | null, now: Date): number | null {
  if (!publishedAt) return null;
  const published = new Date(publishedAt).getTime();
  if (Number.isNaN(published)) return null;
  // Published in the last 24 h still counts as one full day (avoids /0 blowups).
  return Math.max(1, (now.getTime() - published) / DAY_MS);
}

export function viewsPerDay(video: VideoRecord, now: Date): number | null {
  if (video.view_count == null || video.view_count <= 0) return null;
  const days = daysSince(video.published_at, now);
  if (days == null) return null;
  return video.view_count / days;
}

export function engagementRate(video: VideoRecord): number | null {
  if (video.view_count == null || video.view_count <= 0) return null;
  return ((video.like_count ?? 0) + (video.comment_count ?? 0)) / video.view_count;
}

export function rankVideos(videos: readonly VideoRecord[], now: Date): ScoredVideo[] {
  const rows = videos.map((video) => ({
    video,
    vpd: viewsPerDay(video, now),
    eng: engagementRate(video),
  }));
  const vpdMax = Math.max(0, ...rows.map((row) => row.vpd ?? 0));
  const engMax = Math.max(0, ...rows.map((row) => row.eng ?? 0));

  const scored = rows.map((row) => {
    const vpdNorm = vpdMax > 0 && row.vpd != null ? row.vpd / vpdMax : 0;
    const engNorm = engMax > 0 && row.eng != null ? row.eng / engMax : 0;
    const reasons: string[] = [];
    if (row.vpd != null) reasons.push(`${Math.round(row.vpd).toLocaleString("en-US")} views/day`);
    if (row.eng != null) reasons.push(`${(row.eng * 100).toFixed(1)}% engagement`);
    if (!reasons.length) reasons.push("no view data");
    return {
      video: row.video,
      viewsPerDay: row.vpd ?? 0,
      engagementRate: row.eng ?? 0,
      score: RANKING_WEIGHTS.velocity * vpdNorm + RANKING_WEIGHTS.engagement * engNorm,
      reasons,
    };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/** Model-facing summary of a ranked batch. */
export function describeRanking(niche: NicheRecord, ranked: readonly ScoredVideo[]): string {
  if (!ranked.length)
    return `No videos collected for "${niche.name}" yet; collection lands with the YouTube API client.`;
  const header = `Top videos for "${niche.name}" (score = ${RANKING_WEIGHTS.velocity}·views/day + ${RANKING_WEIGHTS.engagement}·engagement, normalized):`;
  const lines = ranked.map(
    (row, index) => `${index + 1}. ${row.video.title} — ${row.reasons.join(" · ")} (${row.video.video_id})`,
  );
  return [header, ...lines].join("\n");
}
