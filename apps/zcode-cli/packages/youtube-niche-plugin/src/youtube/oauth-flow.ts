import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  buildAuthUrl,
  createPkcePair,
  exchangeCode,
  loopbackRedirectUri,
  OAUTH_SCOPES,
  OAuthError,
  parseCallback,
  type TokenPost,
} from "#niche/youtube/oauth.ts";
import type { StoredTokens } from "#niche/youtube/token-store.ts";

/**
 * The loopback leg of the OAuth flow (RFC 8252): listen on 127.0.0.1, build
 * the consent URL for that port, accept exactly one valid redirect, then
 * exchange the code with the injected `post` (fixtures in tests, fetch in
 * production). Split into start/result so the server tool can hand the URL
 * to the user immediately and settle the tokens in a follow-up call.
 */

export type OAuthFlowFailure = "timeout" | "denied" | "aborted" | "exchange_failed";

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly failure: OAuthFlowFailure,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

export interface LoopbackFlowOptions {
  clientId: string;
  scopes?: readonly string[];
  /** 0 (default) picks an ephemeral port. */
  port?: number;
  /** How long to wait for the browser redirect (default 5 minutes). */
  timeoutMs?: number;
  /** Surfaced with the consent URL; default prints to stderr. */
  presentUrl?: (url: string) => void;
  /** Injected token-exchange POST — never the real endpoint in tests. */
  post: TokenPost;
}

export interface StartedFlow {
  authUrl: string;
  port: number;
  state: string;
  redirectUri: string;
  /** Resolves with stored-shaped tokens after callback + exchange. */
  result: Promise<StoredTokens>;
}

const respond = (res: ServerResponse, status: number, title: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>zcode</title><h3>${title}</h3>`);
};

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function closeServer(server: Server): void {
  server.close();
  server.closeAllConnections();
}

export async function startLoopbackFlow(opts: LoopbackFlowOptions): Promise<StartedFlow> {
  const scopes = opts.scopes ?? OAUTH_SCOPES;
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString("hex");

  // The dispatcher is swapped in after listen() reveals the port; requests
  // arriving in between (there are none in practice) get a 503.
  let dispatch: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) =>
    respond(res, 503, "Starting");
  const server = createServer((req, res) => dispatch(req, res));

  let port: number;
  try {
    port = await listen(server, opts.port ?? 0);
  } catch (error) {
    throw new OAuthFlowError(`loopback listener failed: ${String(error)}`, "aborted");
  }
  const redirectUri = loopbackRedirectUri(port);
  const authUrl = buildAuthUrl({
    clientId: opts.clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    scopes,
  });
  const present =
    opts.presentUrl ?? ((url: string) => console.error(`[youtube-niche] open to authorize: ${url}`));
  present(authUrl);

  // The wait + exchange run detached: startLoopbackFlow resolves right away
  // with the URL so the caller can surface it, while `result` settles later.
  const result = (async () => {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        closeServer(server);
        reject(new OAuthFlowError("timed out waiting for the consent redirect", "timeout"));
      }, opts.timeoutMs ?? 300_000);
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        closeServer(server);
        finish();
      };
      dispatch = (req, res) => {
        if (!req.url) return void respond(res, 400, "Missing request URL");
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") return void respond(res, 404, "Not found");
        let parsed;
        try {
          parsed = parseCallback(url);
        } catch {
          return void respond(res, 400, "Callback must carry a code or an error");
        }
        if (parsed.state !== state) return void respond(res, 403, "State mismatch — restart the flow");
        if (parsed.error) {
          respond(res, 200, `Consent denied: ${parsed.error}`);
          return void settle(() =>
            reject(new OAuthFlowError(`consent denied: ${parsed.error}`, "denied")),
          );
        }
        respond(res, 200, "Authorization received — you can close this tab.");
        settle(() => resolve(parsed.code!));
      };
    });

    const response = await exchangeCode(opts.post, {
      clientId: opts.clientId,
      code,
      codeVerifier: verifier,
      redirectUri,
    }).catch((error: unknown) => {
      throw error instanceof OAuthError
        ? new OAuthFlowError(error.message, "exchange_failed")
        : error;
    });

    return {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_at: new Date(Date.now() + response.expires_in * 1000).toISOString(),
      scope: response.scope,
    } satisfies StoredTokens;
  })();
  // A pending flow nobody finishes must not crash the process as an
  // unhandled rejection; finish still awaits the original promise.
  result.catch(() => {});

  return { authUrl, port, state, redirectUri, result };
}

/** One-shot variant for scripts: start, wait for the callback, exchange. */
export async function runLoopbackFlow(opts: LoopbackFlowOptions): Promise<StoredTokens> {
  const flow = await startLoopbackFlow(opts);
  return flow.result;
}
