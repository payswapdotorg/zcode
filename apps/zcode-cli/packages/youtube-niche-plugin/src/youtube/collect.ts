import type { VideoRecord } from "#niche/contract.ts";
import type { YouTubeClient, VideoStats } from "#niche/youtube/client.ts";

export interface CollectResult {
  niche: string;
  found: number;
  collected: number;
  channels: number;
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
 * One collection pass for a niche: discover videos by search (the expensive
 * 100-unit call), read their stats (1 unit per 50 ids), upsert them plus the
 * channels behind them, and report the quota position afterwards. Re-runs
 * refresh stats instead of duplicating rows (upsert on (niche_id, video_id)).
 */
export async function collectForNiche(
  client: YouTubeClient,
  db: { addVideo(nicheId: number, video: VideoRecord): boolean; addChannel(nicheId: number, channelId: string, title: string): boolean },
  nicheId: number,
  nicheName: string,
  opts: { maxResults?: number } = {},
): Promise<CollectResult> {
  const search = await client.searchVideoIds(nicheName, { maxResults: opts.maxResults ?? 10 });
  const videos = await client.fetchVideoStats(search.videoIds);
  if (search.channelIds.length) {
    const channels = await client.fetchChannelInfo(search.channelIds);
    for (const channel of channels) db.addChannel(nicheId, channel.channelId, channel.title);
  }
  const collectedAt = new Date().toISOString();
  for (const video of videos) db.addVideo(nicheId, toRecord(video, collectedAt));

  const quota = client.quotaSnapshot();
  return {
    niche: nicheName,
    found: search.videoIds.length,
    collected: videos.length,
    channels: search.channelIds.length,
    quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
  };
}
