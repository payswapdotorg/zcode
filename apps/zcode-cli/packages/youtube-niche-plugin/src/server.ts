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
import { exportComparison, exportNiche } from "#niche/export.ts";
import {
  compareNiches,
  computeMomentum,
  describeChannelRanking,
  describeNicheComparison,
  describeRanking,
  describeTrends,
  rankChannels,
  rankVideos,
} from "#niche/ranking.ts";
import {
  QuotaExceededError,
  YouTubeApiError,
  YouTubeClient,
  YouTubeNotConfiguredError,
} from "#niche/youtube/client.ts";
import type { QuotaKv } from "#niche/youtube/quota.ts";
import { collectForNiche } from "#niche/youtube/collect.ts";
import { fetchTokenPost, OAuthError, type TokenPost } from "#niche/youtube/oauth.ts";
import { OAuthFlowError, startLoopbackFlow, type StartedFlow } from "#niche/youtube/oauth-flow.ts";
import { OAuthSession } from "#niche/youtube/oauth-session.ts";
import { loadTokens, saveTokens, type StoredTokens } from "#niche/youtube/token-store.ts";

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
  const postImpl: TokenPost = post ?? fetchTokenPost;
  /**
   * OAuth-backed client with a rotating session: the token refreshes inside
   * the expiry window or on a 401 and every rotation persists back to the
   * encrypted store. Replacing the client (not reusing one built at startup)
   * also heals a stale-token client after a reconnect.
   */
  const sessionClient = (tokens: StoredTokens): YouTubeClient =>
    new YouTubeClient({
      kv: kvForDb(),
      session: new OAuthSession({
        ...(clientId ? { clientId } : {}),
        tokens,
        ...(tokenKey && dataDir
          ? { save: (next) => saveTokens(dataDir, tokenKey, next) }
          : {}),
        ...(post ? { post } : {}),
      }),
    });
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
          `Collected ${result.collected} new-or-refreshed videos for "${name}" (search found ${result.found}${result.publishedAfter ? `, incremental since ${result.publishedAfter}` : ""}; ${result.channels} channels${result.refreshed ? `; refreshed stats for ${result.refreshed} tracked videos` : ""}; quota: ${result.quota.used}/${result.quota.limit} units used today, ${result.quota.remaining} remaining).`,
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
    "niche_export",
    {
      description:
        "Export a niche to a file under the plugin's exports directory: format csv/markdown = the ranked videos (niche_rank score, views/day, engagement); format report = a full Markdown report with momentum summary, ranked videos with trends, channel leaderboard and the cross-niche position. Offline: exports whatever is already collected.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        format: z.enum(["csv", "markdown", "report"]).default("csv"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async ({ name, format, limit }) => {
      const niche = db.getNiche(name);
      if (!niche)
        return textResult(`Niche "${name}" is not tracked.`, { niche: name, exported: false });
      if (!dataDir)
        return textResult("Export needs the plugin data directory (host wiring).", {
          niche: name,
          exported: false,
        });
      const result = exportNiche({
        db,
        niche,
        format,
        ...(limit ? { limit } : {}),
        dataDir,
      });
      if (!result.ok)
        return textResult(result.reason, { niche: name, exported: false, reason: result.reason });
      return textResult(
        `Exported ${result.rows} videos for "${name}" to ${result.path} (${result.bytes} bytes, ${format === "csv" ? "CSV" : format === "report" ? "Markdown report" : "Markdown"}).`,
        {
          niche: name,
          exported: true,
          path: result.path,
          rows: result.rows,
          bytes: result.bytes,
          format,
        },
      );
    },
  );

  server.registerTool(
    "niche_export_compare",
    {
      description:
        "Export the cross-niche comparison (the niche_compare view) to a CSV or Markdown file under the plugin's exports directory — one row per niche with views/day, engagement, momentum counts, the accelerating share and the composite score, hottest first. Offline: exports whatever is already collected.",
      inputSchema: {
        format: z.enum(["csv", "markdown"]).default("csv"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async ({ format, limit }) => {
      if (!dataDir)
        return textResult("Export needs the plugin data directory (host wiring).", {
          exported: false,
        });
      const result = exportComparison({
        db,
        format,
        ...(limit ? { limit } : {}),
        dataDir,
      });
      if (!result.ok)
        return textResult(result.reason, { exported: false, reason: result.reason });
      return textResult(
        `Exported ${result.rows} niches to ${result.path} (${result.bytes} bytes, ${format === "csv" ? "CSV" : "Markdown"}).`,
        {
          exported: true,
          path: result.path,
          rows: result.rows,
          bytes: result.bytes,
          format,
        },
      );
    },
  );

  server.registerTool(
    "niche_channels",
    {
      description:
        "Rank the channels of a niche by dominance in the collected data — avg views/day per video plus channel-level engagement, same weights as niche_rank. Offline: no extra API calls, grouped from what is already collected.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: surfaceMeta,
    },
    async ({ name, limit }) => {
      const niche = db.getNiche(name);
      if (!niche)
        return textResult(`Niche "${name}" is not tracked.`, { niche: name, channels: [] });
      const ranked = rankChannels(db.listVideos(niche.id), new Date()).slice(0, limit ?? 10);
      // Join display titles from the channels table; unknown ids stay honest.
      const titles = new Map(db.listChannels(niche.id).map((channel) => [channel.channel_id, channel.title]));
      for (const row of ranked) row.title = row.channelId ? titles.get(row.channelId) ?? row.channelId : null;
      return textResult(describeChannelRanking(niche, ranked), { niche: niche.name, channels: ranked });
    },
  );

  server.registerTool(
    "niche_trends",
    {
      description:
        "Momentum report for a niche: compares views/day between stats snapshots (one per collection) with lifetime views/day — accelerating / steady / cooling per video, sorted by momentum. Offline: pure history math, no extra API calls; needs ≥2 collections ≥1 day apart, otherwise reports 'insufficient' honestly.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: surfaceMeta,
    },
    async ({ name, limit }) => {
      const niche = db.getNiche(name);
      if (!niche) return textResult(`Niche "${name}" is not tracked.`, { niche: name, trends: [] });
      const momentum = computeMomentum(
        db.listVideos(niche.id),
        db.listVideoStats(niche.id),
        new Date(),
      ).slice(0, limit ?? 10);
      return textResult(describeTrends(niche, momentum), {
        niche: niche.name,
        trends: momentum.map((row) => ({
          video_id: row.video.video_id,
          title: row.video.title,
          trend: row.trend,
          lifetimeVpd: row.lifetimeVpd,
          recentVpd: row.recentVpd,
          ratio: row.ratio,
        })),
      });
    },
  );

  server.registerTool(
    "niche_compare",
    {
      description:
        "Compare every tracked niche in one batch — mean views/day and engagement are normalized across niches and blended with the accelerating share of classified videos (40%·velocity + 20%·engagement + 40%·momentum), hottest first. Offline: pure aggregation over what is already collected, no extra API calls.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: surfaceMeta,
    },
    async ({ limit }) => {
      const inputs = db.listNiches().map((niche) => ({
        niche,
        videos: db.listVideos(niche.id),
        stats: db.listVideoStats(niche.id),
      }));
      const comparison = compareNiches(inputs, new Date()).slice(0, limit ?? 20);
      return textResult(describeNicheComparison(comparison), {
        comparison: comparison.map((row) => ({
          niche: row.niche.name,
          videoCount: row.videoCount,
          totalViews: row.totalViews,
          viewsPerDay: row.viewsPerDay,
          engagementRate: row.engagementRate,
          accelerating: row.accelerating,
          steady: row.steady,
          cooling: row.cooling,
          insufficient: row.insufficient,
          heat: row.heat,
          score: row.score,
          ...(row.topMover ? { topMover: row.topMover } : {}),
        })),
      });
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
      // Fresh token, or an expired one the session can refresh on its own.
      if (
        existing &&
        (Date.parse(existing.expires_at) > Date.now() + 60_000 ||
          (existing.refresh_token && clientId))
      )
        return textResult(
          `YouTube is already connected (access token expires ${existing.expires_at}${existing.refresh_token && clientId ? "; expired tokens refresh automatically" : ""}). Re-run after expiry or clear the token store to reconnect.`,
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
          post: postImpl,
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
        // Always swap in a fresh session-backed client — reusing one built at
        // startup would keep its (possibly stale) token forever.
        activeClient = sessionClient(tokens);
        return textResult(
          `YouTube connected — tokens stored encrypted (access token expires ${tokens.expires_at}; refreshes automatically). niche_collect is live.`,
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
