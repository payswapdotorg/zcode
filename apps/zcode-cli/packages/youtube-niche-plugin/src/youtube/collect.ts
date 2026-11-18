import type { VideoRecord } from "#niche/contract.ts";
import type { YouTubeClient, VideoStats } from "#niche/youtube/client.ts";

/** Skip window for the recent-collection guard: 100 units per search is the
 * niche store's only expensive call, so re-searching within hours is waste. */
export const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

const lastCollectKey = (nicheId: number) => `last_collect:${nicheId}`;

export interface CollectOptions {
  maxResults?: number;
  /** Force a fresh search even when the last collection is recent. */
  fresh?: boolean;
  /** Recent-collection skip window (default 6h; tests shrink it). */
  minIntervalMs?: number;
}

export interface CollectResult {
  niche: string;
  found: number;
  collected: number;
  channels: number;
  /** false when the search was skipped as recent (quota preserved). */
  searched: boolean;
  skippedReason?: "recent";
  /** ISO timestamp the incremental search window started from. */
  publishedAfter?: string;
  lastCollectedAt?: string;
  /** Stats refreshes of already-tracked videos (≤50 most recent; momentum fuel). */
  refreshed: number;
  /** Tracked video count when the run started. */
  tracked: number;
  quota: { used: number; limit: number; remaining: number };
}

const toRecord = (video: VideoStats, collectedAt: string): VideoRecord => ({
  video_id: video.videoId,
  title: video.title,
  channel_id: video.channelId || null,
  published_at: video.publishedAt,
  view_count: video.viewCount,
  like_count: video.likeCount,
  comment_count: video.commentCount,
  duration_seconds: video.durationSeconds,
  collected_at: collectedAt,
});

/**
 * One collection pass for a niche, incremental by default: a search within
 * the skip window is refused (quota preserved, `fresh` overrides), and any
 * later pass searches only videos published since the last collection
 * (publishedAfter). Videos and the channels behind them are upserted, so
 * re-collection refreshes stats instead of duplicating rows. Because the
 * incremental search never returns older videos, each run also refreshes the
 * stats of up to 50 already-tracked videos with one videos.list call (1
 * quota unit) — without that pass every tracked video would keep a single
 * stats snapshot and momentum could never be computed.
 */
export async function collectForNiche(
  client: YouTubeClient,
  db: {
    addVideo(nicheId: number, video: VideoRecord): boolean;
    addChannel(nicheId: number, channelId: string, title: string): boolean;
    listVideos(nicheId: number): VideoRecord[];
    getMeta(key: string): string | undefined;
    setMeta(key: string, value: string): void;
  },
  nicheId: number,
  nicheName: string,
  opts: CollectOptions = {},
  now = new Date(),
): Promise<CollectResult> {
  const metaKey = lastCollectKey(nicheId);
  const lastCollectedAt = db.getMeta(metaKey);
  const lastMs = lastCollectedAt ? Date.parse(lastCollectedAt) : NaN;
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  if (!opts.fresh && !Number.isNaN(lastMs) && now.getTime() - lastMs < minInterval) {
    return {
      niche: nicheName,
      found: 0,
      collected: 0,
      channels: 0,
      searched: false,
      skippedReason: "recent",
      refreshed: 0,
      tracked: 0,
      ...(lastCollectedAt ? { lastCollectedAt } : {}),
      quota: client.quotaSnapshot(now),
    };
  }

  // Read before the search upserts anything: the refresh pass targets videos
  // the incremental window cannot return anymore (listVideos is most recent
  // first, so the cap keeps the 50 most recently seen).
  const tracked = db.listVideos(nicheId);
  const publishedAfter = lastCollectedAt && !Number.isNaN(lastMs) ? lastCollectedAt : undefined;
  const search = await client.searchVideoIds(nicheName, {
    maxResults: opts.maxResults ?? 10,
    ...(publishedAfter ? { publishedAfter } : {}),
  });
  const videos = await client.fetchVideoStats(search.videoIds);
  if (search.channelIds.length) {
    const channels = await client.fetchChannelInfo(search.channelIds);
    for (const channel of channels) db.addChannel(nicheId, channel.channelId, channel.title);
  }
  const collectedAt = now.toISOString();
  for (const video of videos) db.addVideo(nicheId, toRecord(video, collectedAt));

  // Stats refresh pass: one 50-id videos.list (1 unit) for tracked videos
  // this run's search did not just collect.
  const justCollected = new Set(videos.map((video) => video.videoId));
  const refreshIds = tracked
    .filter((video) => !justCollected.has(video.video_id))
    .slice(0, 50)
    .map((video) => video.video_id);
  let refreshed = 0;
  if (refreshIds.length) {
    const stats = await client.fetchVideoStats(refreshIds);
    refreshed = stats.length;
    for (const video of stats) db.addVideo(nicheId, toRecord(video, collectedAt));
  }
  db.setMeta(metaKey, collectedAt);

  return {
    niche: nicheName,
    found: search.videoIds.length,
    collected: videos.length,
    channels: search.channelIds.length,
    searched: true,
    refreshed,
    tracked: tracked.length,
    ...(publishedAfter ? { publishedAfter } : {}),
    quota: client.quotaSnapshot(now),
  };
}
