import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  OAUTH_SCOPES,
  OAuthError,
  buildAuthUrl,
  createPkcePair,
  exchangeCode,
  loopbackRedirectUri,
  parseCallback,
  refreshAccessToken,
  type TokenPost,
} from "#niche/youtube/oauth.ts";

describe("PKCE", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash("sha256").update(verifier).digest().toString("base64url");
    expect(challenge).toBe(expected);
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});

describe("consent URL and callback", () => {
  it("builds an offline-access, PKCE-S256 consent URL for a loopback redirect", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "client-1.apps.googleusercontent.com",
        redirectUri: loopbackRedirectUri(45123),
        state: "state-abc",
        codeChallenge: "challenge-xyz",
      }),
    );
    expect(url.href.startsWith(GOOGLE_AUTH_ENDPOINT)).toBe(true);
    expect(url.searchParams.get("client_id")).toBe("client-1.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:45123/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("parses code and error callbacks", () => {
    expect(parseCallback(new URL("http://127.0.0.1:1/callback?code=a.b&state=s"))).toEqual({
      code: "a.b",
      state: "s",
    });
    expect(parseCallback(new URL("http://127.0.0.1:1/callback?error=access_denied"))).toEqual({
      error: "access_denied",
    });
    expect(() => parseCallback(new URL("http://127.0.0.1:1/callback"))).toThrow(OAuthError);
  });
});

describe("exchangeCode", () => {
  it("posts the authorization_code grant with the verifier and parses tokens", async () => {
    const seen: Array<{ endpoint: string; body: Record<string, string> }> = [];
    const tokens = await exchangeCode(
      async (endpoint, body) => {
        seen.push({ endpoint, body });
        return {
          status: 200,
          json: {
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
            token_type: "Bearer",
            scope: OAUTH_SCOPES.join(" "),
          },
        };
      },
      {
        clientId: "client-1",
        code: "the-code",
        codeVerifier: "the-verifier",
        redirectUri: "http://127.0.0.1:45123/callback",
      },
    );
    expect(seen[0]!.endpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(seen[0]!.body).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "client-1",
      code_verifier: "the-verifier",
      redirect_uri: "http://127.0.0.1:45123/callback",
    });
    expect(tokens).toEqual({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      token_type: "Bearer",
      scope: OAUTH_SCOPES.join(" "),
    });
  });

  it("surfaces Google error responses", async () => {
    await expect(
      exchangeCode(
        async () => ({ status: 400, json: { error: "invalid_grant", error_description: "bad code" } }),
        { clientId: "c", code: "x", codeVerifier: "v", redirectUri: "http://127.0.0.1:1/callback" },
      ),
    ).rejects.toThrow(/invalid_grant: bad code/);
    await expect(
      exchangeCode(async () => ({ status: 200, json: { token_type: "Bearer" } }), {
        clientId: "c",
        code: "x",
        codeVerifier: "v",
        redirectUri: "http://127.0.0.1:1/callback",
      }),
    ).rejects.toThrow(OAuthError);
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh grant and parses the rotated token", async () => {
    const bodies: Record<string, string>[] = [];
    const post: TokenPost = async (endpoint, body) => {
      expect(endpoint).toBe(GOOGLE_TOKEN_ENDPOINT);
      bodies.push(body);
      return {
        status: 200,
        json: { access_token: "at-2", expires_in: 3600, token_type: "Bearer" },
      };
    };
    const tokens = await refreshAccessToken(post, { clientId: "client-1", refreshToken: "rt-1" });
    expect(bodies[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "client-1",
    });
    expect(tokens).toEqual({ access_token: "at-2", expires_in: 3600, token_type: "Bearer" });
  });

  it("surfaces revoked grants and malformed responses", async () => {
    await expect(
      refreshAccessToken(
        async () => ({
          status: 400,
          json: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        }),
        { clientId: "c", refreshToken: "rt" },
      ),
    ).rejects.toThrow(/token refresh failed \(400\) invalid_grant/);
    await expect(
      refreshAccessToken(async () => ({ status: 200, json: { token_type: "Bearer" } }), {
        clientId: "c",
        refreshToken: "rt",
      }),
    ).rejects.toThrow(OAuthError);
  });
});
