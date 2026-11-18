import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openNicheDatabase } from "#niche/db.ts";
import { createNicheServer, type SchedulerOptions } from "#niche/server.ts";
import { YouTubeClient } from "#niche/youtube/client.ts";
import type { TokenPost } from "#niche/youtube/oauth.ts";

/** Wiring knobs for makeConnect; mirrors createNicheServer's optional deps. */
export interface ConnectDeps {
  youtube?: YouTubeClient;
  tokenKey?: Buffer;
  dataDir?: string;
  clientId?: string;
  post?: TokenPost;
  exportScheduler?: SchedulerOptions;
  collectionScheduler?: SchedulerOptions;
}

/**
 * Shared in-memory wiring for server tests: creates the db, links a client
 * and the server over an in-memory transport, and registers cleanup with the
 * caller's afterEach registries (closers for transports, dirs for temp data).
 */
export function makeConnect(
  closers: (() => Promise<void>)[],
  dirs: string[],
): (opts?: ConnectDeps) => Promise<{ client: Client; db: ReturnType<typeof openNicheDatabase> }> {
  return async (opts: ConnectDeps = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
    dirs.push(dir);
    const db = openNicheDatabase(dir);
    const server = createNicheServer({
      db,
      // support/ sits one level deeper than the test files it serves.
      assetRoot: resolve(import.meta.dirname, "../../ui"),
      ...(opts.youtube ? { youtube: opts.youtube } : {}),
      ...(opts.tokenKey ? { tokenKey: opts.tokenKey } : {}),
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.post ? { post: opts.post } : {}),
      ...(opts.exportScheduler ? { exportScheduler: opts.exportScheduler } : {}),
      ...(opts.collectionScheduler ? { collectionScheduler: opts.collectionScheduler } : {}),
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    closers.push(() => client.close());
    return { client, db };
  };
}
