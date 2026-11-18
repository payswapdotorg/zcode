import { describe, expect, it } from "vitest";
import { GOOGLE_AUTH_ENDPOINT, type TokenPost } from "#niche/youtube/oauth.ts";
import { startLoopbackFlow } from "#niche/youtube/oauth-flow.ts";

const okPost: TokenPost = async () => ({
  status: 200,
  json: {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    token_type: "Bearer",
  },
});

describe("startLoopbackFlow", () => {
  it("builds the consent URL and settles tokens after the callback", async () => {
    const flow = await startLoopbackFlow({ clientId: "cid", post: okPost, timeoutMs: 5000 });
    const url = new URL(flow.authUrl);
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(flow.redirectUri);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.redirectUri).toBe(`http://127.0.0.1:${flow.port}/callback`);

    const response = await fetch(
      `http://127.0.0.1:${flow.port}/callback?code=ac-1&state=${flow.state}`,
    );
    expect(response.status).toBe(200);
    const tokens = await flow.result;
    expect(tokens.access_token).toBe("at-1");
    expect(tokens.refresh_token).toBe("rt-1");
    expect(Date.parse(tokens.expires_at)).toBeGreaterThan(Date.now());
  });

  it("rejects wrong paths and states, then completes on the right one", async () => {
    const flow = await startLoopbackFlow({ clientId: "cid", post: okPost, timeoutMs: 5000 });
    const other = await fetch(`http://127.0.0.1:${flow.port}/other?code=x&state=${flow.state}`);
    expect(other.status).toBe(404);
    const bad = await fetch(`http://127.0.0.1:${flow.port}/callback?code=x&state=wrong`);
    expect(bad.status).toBe(403);
    const good = await fetch(
      `http://127.0.0.1:${flow.port}/callback?code=ac-2&state=${flow.state}`,
    );
    expect(good.status).toBe(200);
    expect((await flow.result).access_token).toBe("at-1");
  });

  it("fails with denied when the callback carries an error", async () => {
    const flow = await startLoopbackFlow({ clientId: "cid", post: okPost, timeoutMs: 5000 });
    const response = await fetch(
      `http://127.0.0.1:${flow.port}/callback?error=access_denied&state=${flow.state}`,
    );
    expect(response.status).toBe(200);
    await expect(flow.result).rejects.toMatchObject({
      name: "OAuthFlowError",
      failure: "denied",
    });
  });

  it("times out when no redirect arrives", async () => {
    const flow = await startLoopbackFlow({ clientId: "cid", post: okPost, timeoutMs: 60 });
    await expect(flow.result).rejects.toMatchObject({
      name: "OAuthFlowError",
      failure: "timeout",
    });
  });

  it("maps token-exchange failures", async () => {
    const post: TokenPost = async () => ({ status: 400, json: { error: "invalid_grant" } });
    const flow = await startLoopbackFlow({ clientId: "cid", post, timeoutMs: 5000 });
    await fetch(`http://127.0.0.1:${flow.port}/callback?code=bad&state=${flow.state}`);
    await expect(flow.result).rejects.toMatchObject({
      name: "OAuthFlowError",
      failure: "exchange_failed",
    });
  });
});
