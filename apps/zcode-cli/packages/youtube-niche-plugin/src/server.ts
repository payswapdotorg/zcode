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
import { collectForNiche } from "#niche/youtube/collect.ts";

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
}: {
  db: NicheDatabase;
  assetRoot: string;
  /** Constructed in main.ts only when API credentials exist; tests inject fixtures. */
  youtube?: YouTubeClient;
}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });

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
      return textResult(text, { niches });
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
        "Discover and collect videos for a niche from the YouTube Data API (search.list 100 units + videos.list/channels.list 1 unit per 50 ids; the quota ledger refuses over-budget runs before spending). Requires API credentials (R2); without them the offline tools keep working.",
      inputSchema: {
        name: z.string().trim().min(1).max(64),
        maxResults: z.number().int().min(1).max(25).optional(),
      },
      annotations: { readOnlyHint: false },
      _meta: surfaceMeta,
    },
    async ({ name, maxResults }) => {
      const niche = db.getNiche(name);
      if (!niche)
        return textResult(`Niche "${name}" is not tracked.`, { niche: name, collected: 0 });
      if (!youtube)
        return textResult(
          `YouTube API credentials are not configured yet (waiting on R2), so "${name}" cannot be collected. niche_add / niche_list / niche_rank keep working offline.`,
          { niche: name, collected: 0, configured: false },
        );
      try {
        const result = await collectForNiche(youtube, db, niche.id, niche.name, { maxResults });
        return textResult(
          `Collected ${result.collected} videos for "${name}" (search found ${result.found}, ${result.channels} channels; quota: ${result.quota.used}/${result.quota.limit} units used today, ${result.quota.remaining} remaining).`,
          { ...result, configured: true },
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

  return server;
}
