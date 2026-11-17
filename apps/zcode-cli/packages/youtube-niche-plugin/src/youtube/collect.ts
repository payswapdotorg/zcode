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
 * re-collection refreshes stats instead of duplicating rows.
 */
export async function collectForNiche(
  client: YouTubeClient,
  db: {
    addVideo(nicheId: number, video: VideoRecord): boolean;
    addChannel(nicheId: number, channelId: string, title: string): boolean;
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
      ...(lastCollectedAt ? { lastCollectedAt } : {}),
      quota: client.quotaSnapshot(now),
    };
  }

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
  db.setMeta(metaKey, collectedAt);

  return {
    niche: nicheName,
    found: search.videoIds.length,
    collected: videos.length,
    channels: search.channelIds.length,
    searched: true,
    ...(publishedAfter ? { publishedAfter } : {}),
    quota: client.quotaSnapshot(now),
  };
}
