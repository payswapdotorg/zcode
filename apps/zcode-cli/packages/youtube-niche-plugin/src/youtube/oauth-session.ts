import {
  fetchTokenPost,
  OAuthError,
  refreshAccessToken,
  type TokenPost,
} from "#niche/youtube/oauth.ts";
import type { StoredTokens } from "#niche/youtube/token-store.ts";

/**
 * Keeps a YouTube OAuth access token usable across its 1-hour lifetime:
 * `getAccessToken` returns the stored token while it is fresh, transparently
 * refreshes it (grant_type=refresh_token) once it is inside the expiry
 * window or when the API answered 401, and persists every rotation through
 * the injected `save` callback (the encrypted token store in production).
 * Concurrent callers share one in-flight refresh; Google never re-issues
 * refresh tokens on this grant, so the existing one is always carried over.
 */
export const REFRESH_WINDOW_MS = 60_000;

export interface OAuthSessionOptions {
  /** Needed for the refresh grant; without it the session degrades to a plain token holder. */
  clientId?: string;
  tokens: StoredTokens;
  /** Persists each rotation (encrypted token store in production). */
  save?: (tokens: StoredTokens) => void;
  /** Injected token POST — never the real endpoint in tests. */
  post?: TokenPost;
  /** Injectable clock for deterministic expiry math in tests. */
  now?: () => Date;
}

export class OAuthSession {
  private tokens: StoredTokens;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(private readonly options: OAuthSessionOptions) {
    this.tokens = options.tokens;
  }

  get expiresAt(): string {
    return this.tokens.expires_at;
  }

  get refreshToken(): string | undefined {
    return this.tokens.refresh_token;
  }

  /** True when a refresh is possible at all (client id + refresh token). */
  canRefresh(): boolean {
    return Boolean(this.options.clientId && this.tokens.refresh_token);
  }

  needsRefresh(now = this.options.now?.() ?? new Date()): boolean {
    const expiresAt = Date.parse(this.tokens.expires_at);
    return !Number.isFinite(expiresAt) || expiresAt - now.getTime() <= REFRESH_WINDOW_MS;
  }

  /**
   * The token for the next request. `force` (the 401 retry path) refreshes
   * even when the stored token still looks fresh. Without refresh
   * capability the stale token is returned and the caller's 401 surfaces
   * honestly instead of looping.
   */
  async getAccessToken(force = false): Promise<string> {
    if (!force && !this.needsRefresh()) return this.tokens.access_token;
    if (!this.canRefresh()) return this.tokens.access_token;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return (await this.refreshing).access_token;
  }

  private async refresh(): Promise<StoredTokens> {
    const clientId = this.options.clientId;
    const refreshToken = this.tokens.refresh_token;
    if (!clientId || !refreshToken) throw new OAuthError("refresh requires clientId and refresh_token");
    const response = await refreshAccessToken(this.options.post ?? fetchTokenPost, {
      clientId,
      refreshToken,
    });
    const now = this.options.now?.() ?? new Date();
    const next: StoredTokens = {
      access_token: response.access_token,
      // Google never re-issues refresh tokens on the refresh grant.
      refresh_token: refreshToken,
      expires_at: new Date(now.getTime() + response.expires_in * 1000).toISOString(),
      ...(response.scope ? { scope: response.scope } : {}),
    };
    this.tokens = next;
    this.options.save?.(next);
    return next;
  }
}
