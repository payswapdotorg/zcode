import type { NicheRecord, VideoRecord, VideoStatPoint } from "#niche/contract.ts";

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

export interface ScoredChannel {
  channelId: string | null;
  /** Display title; null until the caller joins listChannels (null → channelId). */
  title: string | null;
  videoCount: number;
  totalViews: number;
  /** Mean of per-video views/day (videos without view data are excluded). */
  viewsPerDay: number;
  /** (total likes + comments) / total views across the channel's videos. */
  engagementRate: number;
  /** 0..1 within the ranked batch, same weights as video scoring. */
  score: number;
  reasons: string[];
}

/**
 * Ranks the channels of a niche from its collected videos — no network, no
 * extra API calls: groups listVideos output by channel_id (null groups into
 * one "unknown" bucket) and scores each channel by the mean views/day of its
 * videos plus channel-level engagement, normalized within the batch with the
 * same weights as video scoring.
 */
export function rankChannels(videos: readonly VideoRecord[], now: Date): ScoredChannel[] {
  const groups = new Map<string | null, VideoRecord[]>();
  for (const video of videos) {
    const bucket = groups.get(video.channel_id);
    if (bucket) bucket.push(video);
    else groups.set(video.channel_id, [video]);
  }
  const rows = [...groups.entries()].map(([channelId, channelVideos]) => {
    const withViews = channelVideos.filter((video) => (video.view_count ?? 0) > 0);
    const totalViews = channelVideos.reduce((sum, video) => sum + (video.view_count ?? 0), 0);
    const totalLikes = channelVideos.reduce((sum, video) => sum + (video.like_count ?? 0), 0);
    const totalComments = channelVideos.reduce((sum, video) => sum + (video.comment_count ?? 0), 0);
    const vpd =
      withViews.length > 0
        ? withViews.reduce((sum, video) => sum + (viewsPerDay(video, now) ?? 0), 0) /
          withViews.length
        : 0;
    const engagement = totalViews > 0 ? (totalLikes + totalComments) / totalViews : 0;
    const reasons: string[] = [];
    if (withViews.length > 0)
      reasons.push(`${Math.round(vpd).toLocaleString("en-US")} views/day avg`);
    else reasons.push("no view data");
    if (totalViews > 0) reasons.push(`${(engagement * 100).toFixed(1)}% engagement`);
    reasons.push(`${channelVideos.length} video${channelVideos.length === 1 ? "" : "s"}`);
    return { channelId, channelVideos, vpd, engagement, totalViews, reasons };
  });
  const vpdMax = Math.max(0, ...rows.map((row) => row.vpd));
  const engMax = Math.max(0, ...rows.map((row) => row.engagement));
  return rows
    .map((row) => ({
      channelId: row.channelId,
      title: null,
      videoCount: row.channelVideos.length,
      totalViews: row.totalViews,
      viewsPerDay: row.vpd,
      engagementRate: row.engagement,
      score:
        RANKING_WEIGHTS.velocity * (vpdMax > 0 ? row.vpd / vpdMax : 0) +
        RANKING_WEIGHTS.engagement * (engMax > 0 ? row.engagement / engMax : 0),
      reasons: row.reasons,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Model-facing summary of a channel leaderboard (titles joined by the caller). */
export function describeChannelRanking(
  niche: NicheRecord,
  ranked: readonly ScoredChannel[],
): string {
  if (!ranked.length)
    return `No videos collected for "${niche.name}" yet; channel leaders appear after the first collection.`;
  const header = `Channel leaders for "${niche.name}" (score = ${RANKING_WEIGHTS.velocity}·avg views/day + ${RANKING_WEIGHTS.engagement}·engagement, normalized):`;
  const lines = ranked.map(
    (row, index) =>
      `${index + 1}. ${row.title ?? row.channelId ?? "unknown"} — ${row.reasons.join(" · ")} (${row.channelId ?? "unknown"})`,
  );
  return [header, ...lines].join("\n");
}

/** Trend classification thresholds: recent vs lifetime views/day. */
export const MOMENTUM_THRESHOLDS = {
  /** recentVpd at or above this multiple of lifetimeVpd counts as accelerating. */
  accelerating: 1.3,
  /** At or below this multiple counts as cooling. */
  cooling: 0.7,
  /** Snapshots closer than this cannot carry a meaningful views/day delta. */
  minWindowDays: 1,
} as const;

export type TrendClassification = "accelerating" | "steady" | "cooling" | "insufficient";

export interface VideoMomentum {
  video: VideoRecord;
  /** Views/day since publish (null without view or publish data). */
  lifetimeVpd: number | null;
  /** Views/day across the snapshot window; null under two usable snapshots or a short window. */
  recentVpd: number | null;
  /** recentVpd / lifetimeVpd; null when either side is missing or lifetime is 0. */
  ratio: number | null;
  trend: TrendClassification;
  reasons: string[];
}

/**
 * Momentum per video: compares the views/day observed between the first and
 * last stats snapshots (recent) with the lifetime views/day since publish.
 * Needs at least two collections at least minWindowDays apart — a single
 * collection honestly reports "insufficient" instead of guessing.
 */
export function computeMomentum(
  videos: readonly VideoRecord[],
  stats: readonly VideoStatPoint[],
  now: Date,
): VideoMomentum[] {
  const series = new Map<string, VideoStatPoint[]>();
  for (const point of stats) {
    if (point.view_count == null) continue;
    const bucket = series.get(point.video_id);
    if (bucket) bucket.push(point);
    else series.set(point.video_id, [point]);
  }
  for (const bucket of series.values())
    bucket.sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at));

  const rows = videos.map((video) => {
    const lifetimeVpd = viewsPerDay(video, now);
    const points = series.get(video.video_id) ?? [];
    let recentVpd: number | null = null;
    if (points.length >= 2) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const windowDays =
        (new Date(last.snapshot_at).getTime() - new Date(first.snapshot_at).getTime()) / DAY_MS;
      if (Number.isFinite(windowDays) && windowDays >= MOMENTUM_THRESHOLDS.minWindowDays)
        recentVpd = (last.view_count! - first.view_count!) / windowDays;
    }
    const ratio =
      recentVpd != null && lifetimeVpd != null && lifetimeVpd > 0
        ? recentVpd / lifetimeVpd
        : null;
    const trend: TrendClassification =
      ratio == null
        ? "insufficient"
        : ratio >= MOMENTUM_THRESHOLDS.accelerating
          ? "accelerating"
          : ratio <= MOMENTUM_THRESHOLDS.cooling
            ? "cooling"
            : "steady";
    const reasons =
      ratio == null
        ? ["needs ≥2 collections ≥1 day apart"]
        : [
            `lifetime ${Math.round(lifetimeVpd!).toLocaleString("en-US")}/day → recent ${Math.round(recentVpd!).toLocaleString("en-US")}/day (${ratio.toFixed(1)}×)`,
          ];
    return { video, lifetimeVpd, recentVpd, ratio, trend, reasons };
  });
  return rows.sort((a, b) => (b.ratio ?? -Infinity) - (a.ratio ?? -Infinity));
}

/** Model-facing trend report: counts plus per-video momentum lines. */
export function describeTrends(niche: NicheRecord, momentum: readonly VideoMomentum[]): string {
  if (!momentum.length)
    return `No videos collected for "${niche.name}" yet; trends appear after collections build history.`;
  const counts = new Map<TrendClassification, number>();
  for (const row of momentum) counts.set(row.trend, (counts.get(row.trend) ?? 0) + 1);
  const summary = `${counts.get("accelerating") ?? 0} accelerating · ${counts.get("steady") ?? 0} steady · ${counts.get("cooling") ?? 0} cooling · ${counts.get("insufficient") ?? 0} insufficient`;
  const header = `Trend report for "${niche.name}" (recent vs lifetime views/day, ≥${MOMENTUM_THRESHOLDS.accelerating}× accelerating, ≤${MOMENTUM_THRESHOLDS.cooling}× cooling): ${summary}`;
  const lines = momentum.map(
    (row, index) => `${index + 1}. ${row.video.title} — ${row.trend}: ${row.reasons.join(" · ")} (${row.video.video_id})`,
  );
  return [header, ...lines].join("\n");
}
