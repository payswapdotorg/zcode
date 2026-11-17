import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { PANEL_URI } from "#niche/contract.ts";
import { openNicheDatabase } from "#niche/db.ts";
import { createNicheServer } from "#niche/server.ts";

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
  dirs.push(dir);
  const db = openNicheDatabase(dir);
  const server = createNicheServer({
    db,
    assetRoot: resolve(import.meta.dirname, "../ui"),
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  return { client, db };
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("\n");
};

describe("youtube-niche server", () => {
  it("serves the Niche Explorer panel resource", async () => {
    const { client } = await connect();
    const resource = await client.readResource({ uri: PANEL_URI });
    const [first] = resource.contents as Array<{ uri: string; text?: string; mimeType?: string }>;
    expect(first?.mimeType).toBe("text/html");
    expect(first?.text).toContain("Niche Explorer");
  });

  it("adds, lists and removes niches through tools", async () => {
    const { client } = await connect();
    const added = await client.callTool({
      name: "niche_add",
      arguments: { name: "budget home espresso", notes: "gear" },
    });
    expect(textOf(added)).toContain("budget home espresso");

    const duplicate = await client.callTool({
      name: "niche_add",
      arguments: { name: "budget home espresso" },
    });
    expect(textOf(duplicate)).toContain("already tracked");

    const listed = await client.callTool({ name: "niche_list", arguments: {} });
    expect(textOf(listed)).toContain("budget home espresso");
    expect(textOf(listed)).toContain("channels: 0");

    const removed = await client.callTool({
      name: "niche_remove",
      arguments: { name: "budget home espresso" },
    });
    expect(textOf(removed)).toContain("Removed");

    const empty = await client.callTool({ name: "niche_list", arguments: {} });
    expect(textOf(empty)).toContain("No niches tracked yet");
  });

  it("ranks collected videos of a niche", async () => {
    const { client, db } = await connect();
    const niche = db.addNiche("budget home espresso");
    const day = 24 * 60 * 60 * 1000;
    db.addVideo(niche.id, {
      video_id: "slow",
      title: "Slow burner",
      channel_id: "c1",
      published_at: new Date(Date.now() - 10 * day).toISOString(),
      view_count: 10000,
      like_count: 100,
      comment_count: 0,
      duration_seconds: null,
      collected_at: new Date().toISOString(),
    });
    db.addVideo(niche.id, {
      video_id: "fast",
      title: "Fast riser",
      channel_id: "c2",
      published_at: new Date(Date.now() - 2 * day).toISOString(),
      view_count: 6000,
      like_count: 300,
      comment_count: 100,
      duration_seconds: null,
      collected_at: new Date().toISOString(),
    });

    const ranked = await client.callTool({
      name: "niche_rank",
      arguments: { name: "budget home espresso" },
    });
    const text = textOf(ranked);
    expect(text).toContain("1. Fast riser");
    expect(text).toContain("2. Slow burner");
    expect(text).toContain("(fast)");

    const untracked = await client.callTool({ name: "niche_rank", arguments: { name: "nope" } });
    expect(textOf(untracked)).toContain("not tracked");

    const fresh = await connect();
    fresh.db.addNiche("empty niche");
    const noVideos = await fresh.client.callTool({
      name: "niche_rank",
      arguments: { name: "empty niche" },
    });
    expect(textOf(noVideos)).toContain("No videos collected");
  });
});
