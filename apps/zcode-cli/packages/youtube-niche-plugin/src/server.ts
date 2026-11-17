import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HTML_MIME,
  PANEL_URI,
  PLUGIN_VERSION,
  SERVER_NAME,
  SURFACE_ID,
} from "#niche/contract.ts";
import { NicheExistsError, type NicheDatabase } from "#niche/db.ts";
import { describeRanking, rankVideos } from "#niche/ranking.ts";
import {
  QuotaExceededError,
  YouTubeApiError,
  YouTubeClient,
  YouTubeNotConfiguredError,
} from "#niche/youtube/client.ts";
import type { QuotaKv } from "#niche/youtube/quota.ts";
import { collectForNiche } from "#niche/youtube/collect.ts";
import { OAuthError, type TokenPost } from "#niche/youtube/oauth.ts";
import { OAuthFlowError, startLoopbackFlow, type StartedFlow } from "#niche/youtube/oauth-flow.ts";
import { loadTokens, saveTokens } from "#niche/youtube/token-store.ts";

/** Tool results leave the server well formed even if stored text is broken. */
const textResult = (text: string, structuredContent?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text }],
  ...(structuredContent ? { structuredContent } : {}),
});

// Results route to the model and the Niche Explorer panel (office-runtime's
// _meta.ui surface routing convention).
const surfaceMeta = {
  ui: { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: ["model", "app"] as const },
};

export function createNicheServer({
  db,
  assetRoot,
  youtube,
  tokenKey,
  dataDir,
  clientId,
  post,
}: {
  db: NicheDatabase;
  assetRoot: string;
  /** Constructed in main.ts only when API credentials exist; tests inject fixtures. */
  youtube?: YouTubeClient;
  /** OAuth wiring; without all three youtube_connect reports unconfigured (R2). */
  tokenKey?: Buffer;
  dataDir?: string;
  clientId?: string;
  /** Injected token-exchange POST; default posts with fetch. */
  post?: TokenPost;
}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });
  // A successful youtube_connect_finish swaps in an OAuth-backed client.
  let activeClient = youtube;
  // The consent flow in flight, if any (started by youtube_connect).
  let pending: StartedFlow | null = null;
  const kvForDb = (): QuotaKv => ({
    get: (key) => db.getMeta(key),
    set: (key, value) => db.setMeta(key, value),
  });
  const defaultPost: TokenPost = async (endpoint, body) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return { status: response.status, json: await response.json() };
  };
  const storedTokens = () => {
    if (!tokenKey || !dataDir) return undefined;
    try {
      return loadTokens(dataDir, tokenKey);
    } catch (error) {
      console.error(`youtube-niche: ignoring token store: ${String(error)}`);
      return undefined;
    }
  };

  server.registerResource(
    "panel",
    PANEL_URI,
    { mimeType: HTML_MIME },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: HTML_MIME,
          text: await readFile(join(assetRoot, "panel.html"), "utf8"),
        },
      ],
    }),
  );

  server.registerTool(
    "niche_add",
    {
      description:
        "Track a new YouTube niche by name (e.g. 'budget home espresso'). Optional notes record why the niche is interesting.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        notes: z.string().max(1000).optional(),
      },
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async ({ name, notes }) => {
      try {
        const niche = db.addNiche(name, notes);
        return textResult(
          `Tracking niche "${niche.name}" (#${niche.id}). Use niche_list to review all tracked niches.`,
          { added: true, niche },
        );
      } catch (error) {
        if (error instanceof NicheExistsError)
          return textResult(`Niche "${name}" is already tracked.`, { added: false, name });
        throw error;
      }
    },
  );

  server.registerTool(
    "niche_list",
    {
      description: "List tracked YouTube niches with channel and video counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: surfaceMeta,
    },
    async () => {
      const niches = db.listNiches();
      const text = niches.length
        ? niches
            .map(
              (niche) =>
                `- ${niche.name}${niche.notes ? ` — ${niche.notes}` : ""} (channels: ${niche.channel_count}, videos: ${niche.video_count})`,
            )
            .join("\n")
        : "No niches tracked yet. Use niche_add to track the first one.";
      const quota = activeClient?.quotaSnapshot();
      return textResult(text, {
        niches,
        ...(quota ? { quota } : {}),
      });
    },
  );

  server.registerTool(
    "niche_remove",
    {
      description:
        "Stop tracking a YouTube niche. Deletes its collected channels and videos with it.",
      inputSchema: { name: z.string().trim().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true },
      _meta: surfaceMeta,
    },
    async ({ name }) => {
      const removed = db.removeNiche(name);
      return textResult(
        removed ? `Removed niche "${name}" and its collected data.` : `Niche "${name}" is not tracked.`,
        { removed, name },
      );
    },
  );

  server.registerTool(
    "niche_rank",
    {
      description:
        "Rank the collected videos of a niche by growth and engagement (60% views/day + 40% engagement rate, normalized within the batch). Video collection itself lands with the YouTube API client.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: surfaceMeta,
    },
    async ({ name, limit }) => {
      const niche = db.getNiche(name);
      if (!niche) return textResult(`Niche "${name}" is not tracked.`, { niche: name, ranked: [] });
      const ranked = rankVideos(db.listVideos(niche.id), new Date()).slice(0, limit ?? 10);
      return textResult(describeRanking(niche, ranked), { niche: niche.name, ranked });
    },
  );

  server.registerTool(
    "niche_collect",
    {
      description:
        "Discover and collect videos for a niche from the YouTube Data API, incremental by default: searches only videos published since the last collection (publishedAfter) and refuses a new search within 6h of the last one unless fresh=true (quota ledger refuses over-budget runs before spending). Requires API credentials (R2); without them the offline tools keep working.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        maxResults: z.number().int().min(1).max(25).optional(),
        fresh: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async ({ name, maxResults, fresh }) => {
      const niche = db.getNiche(name);
      if (!niche)
        return textResult(`Niche "${name}" is not tracked.`, { niche: name, collected: 0 });
      if (!activeClient)
        return textResult(
          `YouTube API credentials are not configured yet (waiting on R2), so "${name}" cannot be collected. niche_add / niche_list / niche_rank keep working offline.`,
          { niche: name, collected: 0, configured: false },
        );
      try {
        const result = await collectForNiche(activeClient, db, niche.id, niche.name, {
          ...(maxResults ? { maxResults } : {}),
          ...(fresh ? { fresh } : {}),
        });
        if (!result.searched)
          return textResult(
            `Skipped the search for "${name}": last collected ${result.lastCollectedAt} (within the 6h window), quota preserved. ${niche.video_count} videos already collected — pass fresh=true to force a new search.`,
            { ...result, videoCount: niche.video_count },
          );
        return textResult(
          `Collected ${result.collected} new-or-refreshed videos for "${name}" (search found ${result.found}${result.publishedAfter ? `, incremental since ${result.publishedAfter}` : ""}; ${result.channels} channels; quota: ${result.quota.used}/${result.quota.limit} units used today, ${result.quota.remaining} remaining).`,
          { ...result },
        );
      } catch (error) {
        if (
          error instanceof YouTubeNotConfiguredError ||
          error instanceof YouTubeApiError ||
          error instanceof QuotaExceededError
        ) {
          return textResult(`niche_collect failed: ${error.message}`, {
            niche: name,
            collected: 0,
            configured: true,
            error: error.message,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "niche_videos",
    {
      description:
        "List the videos collected for a niche (most recent first) with views, likes, comments and duration. Data appears after niche_collect runs with API credentials (R2).",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: surfaceMeta,
    },
    async ({ name, limit }) => {
      const niche = db.getNiche(name);
      if (!niche) return textResult(`Niche "${name}" is not tracked.`, { niche: name, videos: [] });
      const videos = db.listVideos(niche.id).slice(0, limit ?? 20);
      const text = videos.length
        ? videos
            .map(
              (video, index) =>
                `${index + 1}. ${video.title} — ${video.view_count ?? 0} views, ${video.like_count ?? 0} likes${video.duration_seconds ? `, ${Math.round(video.duration_seconds / 60)} min` : ""}`,
            )
            .join("\n")
        : `No videos collected for "${name}" yet. niche_collect fills this once API credentials are configured (R2).`;
      return textResult(text, { niche: niche.name, videos });
    },
  );

  server.registerTool(
    "youtube_connect",
    {
      description:
        "Start the YouTube OAuth consent flow (PKCE, loopback redirect). Returns the authorization URL — open it in a browser, consent, then call youtube_connect_finish. Requires R2 credentials (client id + token key); without them the offline niche tools keep working.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async () => {
      if (!clientId || !tokenKey || !dataDir)
        return textResult(
          "OAuth is not configured yet (waiting on R2: client id + token key). The offline niche tools keep working.",
          { connected: false, configured: false },
        );
      const existing = storedTokens();
      if (existing && Date.parse(existing.expires_at) > Date.now() + 60_000)
        return textResult(
          `YouTube is already connected (access token expires ${existing.expires_at}). Re-run after expiry or clear the token store to reconnect.`,
          { connected: true, expiresAt: existing.expires_at },
        );
      if (pending)
        return textResult(
          `A consent flow is already pending on port ${pending.port} — open the URL and finish with youtube_connect_finish.`,
          { pending: true, authUrl: pending.authUrl, port: pending.port },
        );
      try {
        pending = await startLoopbackFlow({
          clientId,
          post: post ?? defaultPost,
        });
      } catch (error) {
        if (error instanceof OAuthFlowError)
          return textResult(`Could not start the consent flow: ${error.message}`, {
            connected: false,
            failure: error.failure,
          });
        throw error;
      }
      return textResult(
        `Consent flow started on port ${pending.port}. Open the authorization URL in a browser, approve access, then call youtube_connect_finish.`,
        { authUrl: pending.authUrl, port: pending.port, state: pending.state },
      );
    },
  );

  server.registerTool(
    "youtube_connect_finish",
    {
      description:
        "Complete the pending YouTube OAuth flow: waits for the loopback redirect, exchanges the code (PKCE), stores the encrypted tokens and enables niche_collect. Call after youtube_connect and browser consent.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async () => {
      if (!pending)
        return textResult(
          "No consent flow is pending. Call youtube_connect first.",
          { connected: false },
        );
      if (!tokenKey || !dataDir)
        return textResult(
          "OAuth is not configured (R2); the pending flow is discarded.",
          { connected: false, configured: false },
        );
      const flow = pending;
      pending = null;
      try {
        const tokens = await flow.result;
        saveTokens(dataDir, tokenKey, tokens);
        if (!activeClient)
          activeClient = new YouTubeClient({ kv: kvForDb(), accessToken: tokens.access_token });
        return textResult(
          `YouTube connected — tokens stored encrypted (access token expires ${tokens.expires_at}). niche_collect is live.`,
          { connected: true, expiresAt: tokens.expires_at },
        );
      } catch (error) {
        if (error instanceof OAuthFlowError || error instanceof OAuthError)
          return textResult(`Connect failed (${error instanceof OAuthFlowError ? error.failure : "exchange"}): ${error.message}`, {
            connected: false,
            error: error.message,
          });
        throw error;
      }
    },
  );

  return server;
}
