import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openNicheDatabase, resolveNicheDataDir } from "#niche/db.ts";
import { createNicheServer } from "#niche/server.ts";
import { YouTubeClient } from "#niche/youtube/client.ts";
import { loadTokens, tokenKeyFromEnv, type StoredTokens } from "#niche/youtube/token-store.ts";

// 官方插件宿主通过导出的 main 启动；导入时直接连接会被宿主判定为无效入口。
export async function main(): Promise<void> {
  const dist = dirname(fileURLToPath(import.meta.url));
  const assetRoot = join(dist, "ui");
  const dataDir = resolveNicheDataDir(process.env, process.cwd());
  const db = openNicheDatabase(dataDir);

  // The YouTube client exists only when credentials do (R2): an API key for
  // simple access, or OAuth tokens from the encrypted store. A tampered token
  // file degrades to "not configured" instead of crashing the server.
  const tokenKey = tokenKeyFromEnv(process.env);
  let tokens: StoredTokens | undefined;
  if (tokenKey) {
    try {
      tokens = loadTokens(dataDir, tokenKey);
    } catch (error) {
      console.error(`youtube-niche: ignoring token store: ${String(error)}`);
    }
  }
  const apiKey = process.env.YOUTUBE_API_KEY?.trim() || undefined;
  const youtube =
    apiKey || tokens?.access_token
      ? new YouTubeClient({
          kv: {
            get: (key) => db.getMeta(key),
            set: (key, value) => db.setMeta(key, value),
          },
          apiKey,
          accessToken: tokens?.access_token,
        })
      : undefined;

  const server = createNicheServer({ db, assetRoot, youtube });
  let stopping = false;
  async function close() {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      db.close();
    }
  }
  process.once("SIGTERM", () => void close().catch(() => {}));
  process.once("SIGINT", () => void close().catch(() => {}));
  process.stdin.once("end", () => void close().catch(() => {}));
  await server.connect(new StdioServerTransport());
}

// 保留独立 Node 进程直接启动的用法。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
