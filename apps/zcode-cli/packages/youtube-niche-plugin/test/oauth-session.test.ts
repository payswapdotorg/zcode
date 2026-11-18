import { describe, expect, it } from "vitest";
import { GOOGLE_TOKEN_ENDPOINT, OAuthError, type TokenPost } from "#niche/youtube/oauth.ts";
import { OAuthSession, REFRESH_WINDOW_MS } from "#niche/youtube/oauth-session.ts";
import type { StoredTokens } from "#niche/youtube/token-store.ts";

const baseTokens = (overrides: Partial<StoredTokens> = {}): StoredTokens => ({
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_at: new Date("2026-11-18T12:00:00Z").toISOString(),
  ...overrides,
});

/** POST spy: records bodies, returns queued responses (last one repeats). */
function fixturePost(
  responses: Array<{ status: number; json: unknown }>,
  bodies: Record<string, string>[],
): TokenPost {
  let index = 0;
  return async (endpoint, body) => {
    expect(endpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
    bodies.push(body);
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return { status: response.status, json: response.json };
  };
}

describe("OAuthSession", () => {
  const now = new Date("2026-11-18T11:00:00Z");

  it("returns the stored token while it is fresh (no network)", async () => {
    const bodies: Record<string, string>[] = [];
    const session = new OAuthSession({
      clientId: "client-1",
      tokens: baseTokens(),
      post: fixturePost([], bodies),
      now: () => now,
    });
    await expect(session.getAccessToken()).resolves.toBe("at-1");
    expect(bodies).toHaveLength(0);
  });

  it("refreshes proactively inside the 60s expiry window and persists the rotation", async () => {
    const saved: StoredTokens[] = [];
    const bodies: Record<string, string>[] = [];
    const session = new OAuthSession({
      clientId: "client-1",
      // Token expires 30s from `now` — inside REFRESH_WINDOW_MS.
      tokens: baseTokens({ expires_at: new Date("2026-11-18T11:00:30Z").toISOString() }),
      save: (tokens) => saved.push(tokens),
      post: fixturePost(
        [{ status: 200, json: { access_token: "at-2", expires_in: 3600, token_type: "Bearer" } }],
        bodies,
      ),
      now: () => now,
    });
    await expect(session.getAccessToken()).resolves.toBe("at-2");
    expect(bodies[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "client-1",
    });
    // Google never re-issues refresh tokens; the session keeps the old one.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      access_token: "at-2",
      refresh_token: "rt-1",
      // expires_at is computed from the injected clock, not Date.now().
      expires_at: new Date("2026-11-18T12:00:00Z").toISOString(),
    });
    expect(session.expiresAt).toBe(saved[0]!.expires_at);
  });

  it("collapses concurrent refreshes into one POST (single flight)", async () => {
    let calls = 0;
    const release: (() => void)[] = [];
    const post: TokenPost = async (_endpoint, _body) => {
      calls++;
      await new Promise<void>((resolve) => release.push(resolve));
      return { status: 200, json: { access_token: "at-2", expires_in: 3600 } };
    };
    const session = new OAuthSession({
      clientId: "client-1",
      tokens: baseTokens({ expires_at: new Date("2026-11-18T11:00:01Z").toISOString() }),
      post,
      now: () => now,
    });
    const first = session.getAccessToken();
    const second = session.getAccessToken();
    for (const resolve of release.splice(0)) resolve();
    expect(await Promise.all([first, second])).toEqual(["at-2", "at-2"]);
    expect(calls).toBe(1);
  });

  it("forces a refresh on demand (the 401 retry path)", async () => {
    const bodies: Record<string, string>[] = [];
    const session = new OAuthSession({
      clientId: "client-1",
      tokens: baseTokens(), // still fresh — force must refresh anyway
      post: fixturePost(
        [{ status: 200, json: { access_token: "at-2", expires_in: 3600 } }],
        bodies,
      ),
      now: () => now,
    });
    expect(session.needsRefresh()).toBe(false);
    await expect(session.getAccessToken(true)).resolves.toBe("at-2");
    expect(bodies).toHaveLength(1);
  });

  it("degrades to the stale token when refresh is impossible (no client id or no refresh token)", async () => {
    const bodies: Record<string, string>[] = [];
    const post = fixturePost([], bodies);
    const noClientId = new OAuthSession({
      tokens: baseTokens({ expires_at: new Date("2026-11-18T10:00:00Z").toISOString() }),
      post,
      now: () => now,
    });
    expect(noClientId.canRefresh()).toBe(false);
    await expect(noClientId.getAccessToken()).resolves.toBe("at-1");
    const noRefreshToken = new OAuthSession({
      clientId: "client-1",
      tokens: baseTokens({ refresh_token: undefined }),
      post,
      now: () => now,
    });
    expect(noRefreshToken.canRefresh()).toBe(false);
    await expect(noRefreshToken.getAccessToken(true)).resolves.toBe("at-1");
    expect(bodies).toHaveLength(0);
  });

  it("propagates refresh failures and retries on the next call", async () => {
    const bodies: Record<string, string>[] = [];
    const session = new OAuthSession({
      clientId: "client-1",
      tokens: baseTokens({ expires_at: new Date("2026-11-18T11:00:01Z").toISOString() }),
      post: fixturePost(
        [
          { status: 400, json: { error: "invalid_grant" } },
          { status: 200, json: { access_token: "at-2", expires_in: 3600 } },
        ],
        bodies,
      ),
      now: () => now,
    });
    await expect(session.getAccessToken()).rejects.toThrow(OAuthError);
    await expect(session.getAccessToken()).resolves.toBe("at-2");
    expect(bodies).toHaveLength(2);
  });

  it("treats an unparsable expiry as needing refresh", () => {
    const session = new OAuthSession({
      clientId: "client-1",
      tokens: baseTokens({ expires_at: "not-a-date" }),
      now: () => now,
    });
    expect(session.needsRefresh()).toBe(true);
    expect(REFRESH_WINDOW_MS).toBe(60_000);
  });
});
