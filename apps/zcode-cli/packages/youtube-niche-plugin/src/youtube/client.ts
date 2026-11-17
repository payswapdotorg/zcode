import { parseISODuration } from "#niche/youtube/duration.ts";
import {
  QuotaExceededError,
  readLedger,
  recordUsage,
  type QuotaKv,
  type QuotaMethod,
} from "#niche/youtube/quota.ts";

export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/** API method names (and quota keys) map to bare REST resource paths. */
const ENDPOINT_PATHS: Record<QuotaMethod, string> = {
  "search.list": "search",
  "videos.list": "videos",
  "channels.list": "channels",
};

export class YouTubeNotConfiguredError extends Error {
  constructor() {
    super("YouTube API credentials are not configured yet (waiting on R2)");
    this.name = "YouTubeNotConfiguredError";
  }
}

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

/** Injectable fetch so every client path is fixture-testable before R2. */
export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface YouTubeClientConfig {
  kv: QuotaKv;
  /** API key (simple access) or OAuth access token — quota is per project either way. */
  apiKey?: string;
  accessToken?: string;
  fetchFn?: FetchLike;
}

export interface VideoStats {
  videoId: string;
  title: string;
  channelId: string;
  publishedAt: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  durationSeconds: number | null;
}

export interface ChannelInfo {
  channelId: string;
  title: string;
  subscriberCount: number | null;
  videoCount: number | null;
}

export interface QuotaSnapshot {
  used: number;
  limit: number;
  remaining: number;
}

type SearchItem = {
  id?: { videoId?: string };
  snippet?: { channelId?: string };
};

type VideoItem = {
  id?: string;
  snippet?: { title?: string; channelId?: string; publishedAt?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
};

type ChannelItem = {
  id?: string;
  snippet?: { title?: string };
  statistics?: { subscriberCount?: string; videoCount?: string };
};

type ApiErrorBody = {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
};

/**
 * YouTube Data API v3 client with the quota ledger in front of every call:
 * the ledger refuses quota-breaking batches *before* any network request is
 * spent. search.list is the expensive discovery call (100 units); targeted
 * videos.list/channels.list reads cost 1 unit per 50-id request.
 */
export class YouTubeClient {
  readonly kv: QuotaKv;
  private readonly apiKey?: string;
  private readonly accessToken?: string;
  private readonly fetchFn: FetchLike;

  constructor(config: YouTubeClientConfig) {
    this.kv = config.kv;
    this.apiKey = config.apiKey?.trim() || undefined;
    this.accessToken = config.accessToken?.trim() || undefined;
    this.fetchFn =
      config.fetchFn ??
      ((url: string, init: { headers?: Record<string, string> }) =>
        fetch(url, init) as unknown as ReturnType<FetchLike>);
  }

  get configured(): boolean {
    return Boolean(this.apiKey || this.accessToken);
  }

  quotaSnapshot(now = new Date()): QuotaSnapshot {
    const ledger = readLedger(this.kv, now);
    return {
      used: ledger.used,
      limit: ledger.limit,
      remaining: Math.max(0, ledger.limit - ledger.used),
    };
  }

  private async call(
    method: QuotaMethod,
    params: Record<string, string>,
    units = 1,
  ): Promise<unknown> {
    if (!this.configured) throw new YouTubeNotConfiguredError();
    // Refuse before spending: throws before any request goes out.
    recordUsage(this.kv, method, new Date(), units);
    const url = new URL(`${YOUTUBE_API_BASE}/${ENDPOINT_PATHS[method]}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    else url.searchParams.set("key", this.apiKey!);

    const response = await this.fetchFn(url.href, { headers });
    const body = (await response.json()) as Record<string, unknown> & ApiErrorBody;
    if (response.status !== 200 || body.error) {
      const reason = body.error?.errors?.[0]?.reason;
      throw new YouTubeApiError(
        response.status,
        reason,
        body.error?.message ?? `YouTube ${method} failed (${response.status})`,
      );
    }
    return body;
  }

  /** Discovery search; returns video ids and the distinct channel ids behind them. */
  async searchVideoIds(
    query: string,
    opts: { maxResults?: number; publishedAfter?: string } = {},
  ): Promise<{ videoIds: string[]; channelIds: string[] }> {
    const params: Record<string, string> = {
      part: "snippet",
      type: "video",
      q: query,
      maxResults: String(Math.min(50, Math.max(1, opts.maxResults ?? 10))),
    };
    if (opts.publishedAfter) params.publishedAfter = opts.publishedAfter;
    const body = await this.call("search.list", params);
    const items = (body as { items?: SearchItem[] }).items ?? [];
    const videoIds: string[] = [];
    const channelIds = new Set<string>();
    for (const item of items) {
      if (item.id?.videoId) videoIds.push(item.id.videoId);
      if (item.snippet?.channelId) channelIds.add(item.snippet.channelId);
    }
    return { videoIds, channelIds: [...channelIds] };
  }

  /** Statistics for up to N ids, chunked into 50-id videos.list requests. */
  async fetchVideoStats(ids: readonly string[]): Promise<VideoStats[]> {
    return this.eachChunk("videos.list", ids, (items) => {
      const videoItems = items as VideoItem[];
      return videoItems.map((item) => ({
        videoId: String(item.id ?? ""),
        title: String(item.snippet?.title ?? ""),
        channelId: String(item.snippet?.channelId ?? ""),
        publishedAt: item.snippet?.publishedAt ?? null,
        viewCount: item.statistics?.viewCount != null ? Number(item.statistics.viewCount) : null,
        likeCount: item.statistics?.likeCount != null ? Number(item.statistics.likeCount) : null,
        commentCount:
          item.statistics?.commentCount != null ? Number(item.statistics.commentCount) : null,
        durationSeconds: parseISODuration(item.contentDetails?.duration),
      }));
    }, { part: "snippet,statistics,contentDetails" });
  }

  /** Channel titles/counts for up to N ids, chunked into 50-id channels.list requests. */
  async fetchChannelInfo(ids: readonly string[]): Promise<ChannelInfo[]> {
    return this.eachChunk("channels.list", ids, (items) => {
      const channelItems = items as ChannelItem[];
      return channelItems.map((item) => ({
        channelId: String(item.id ?? ""),
        title: String(item.snippet?.title ?? ""),
        subscriberCount:
          item.statistics?.subscriberCount != null ? Number(item.statistics.subscriberCount) : null,
        videoCount: item.statistics?.videoCount != null ? Number(item.statistics.videoCount) : null,
      }));
    }, { part: "snippet,statistics" });
  }

  private async eachChunk<T>(
    method: "videos.list" | "channels.list",
    ids: readonly string[],
    map: (items: unknown[]) => T[],
    base: Record<string, string>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; offset < ids.length; offset += 50) {
      const chunk = ids.slice(offset, offset + 50);
      const body = await this.call(method, { ...base, id: chunk.join(",") });
      out.push(...map((body as { items?: unknown[] }).items ?? []));
    }
    return out;
  }
}

// Re-exported for tool-layer error handling without a second import site.
export { QuotaExceededError };
