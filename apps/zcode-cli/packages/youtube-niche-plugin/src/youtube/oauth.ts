import { createHash, randomBytes } from "node:crypto";

/**
 * Loopback OAuth helpers for the YouTube Data API (desktop app, public
 * client, PKCE): build the Google consent URL for a loopback redirect
 * (http://127.0.0.1:<port>/callback, RFC 8252 style — same shape as the CLI's
 * own localhost-callback flow), parse the callback, and exchange the code.
 * The token endpoint is only ever touched through the injected `post`
 * function, so every path stays unit-testable before R2 delivers the real
 * client id.
 */
export const OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"] as const;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

export function createPkcePair(): PkcePair {
  // 32 random bytes → a 43-char base64url verifier (RFC 7636 minimum length).
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (params.scopes ?? OAUTH_SCOPES).join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // refresh_token is only issued on the first consent unless access_type=offline.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.href;
}

export interface CallbackResult {
  code?: string;
  error?: string;
  state?: string;
}

export function parseCallback(url: URL): CallbackResult {
  const code = url.searchParams.get("code") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  if (!code && !error) throw new OAuthError(`callback has neither code nor error: ${url.href}`);
  return { code, error, state };
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

/** Minimal injected POST so tests can drive the exchange with fixtures. */
export type TokenPost = (
  endpoint: string,
  body: Record<string, string>,
) => Promise<{ status: number; json: unknown }>;

export async function exchangeCode(
  post: TokenPost,
  params: { clientId: string; code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenResponse> {
  const response = await post(GOOGLE_TOKEN_ENDPOINT, {
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  const body = response.json as Record<string, unknown>;
  if (response.status !== 200 || typeof body.error === "string") {
    const detail =
      typeof body.error_description === "string" ? `: ${body.error_description}` : "";
    throw new OAuthError(`token exchange failed (${response.status}) ${String(body.error ?? "")}${detail}`);
  }
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
    throw new OAuthError("token response is missing access_token or expires_in");
  }
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expires_in: body.expires_in,
    token_type: typeof body.token_type === "string" ? body.token_type : "Bearer",
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}
