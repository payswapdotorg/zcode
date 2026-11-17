import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DB_FILE_NAME,
  DB_SCHEMA_VERSION,
  type NicheRecord,
  type VideoRecord,
} from "#niche/contract.ts";

export class NicheExistsError extends Error {
  constructor(name: string) {
    super(`niche already tracked: ${name}`);
    this.name = "NicheExistsError";
  }
}

export interface NicheDatabase {
  addNiche(name: string, notes?: string): NicheRecord;
  getNiche(name: string): NicheRecord | undefined;
  listNiches(): NicheRecord[];
  removeNiche(name: string): boolean;
  /** Upserts a collected video snapshot (stats refresh on re-collection). */
  addVideo(nicheId: number, video: VideoRecord): boolean;
  listVideos(nicheId: number): VideoRecord[];
  close(): void;
}

/**
 * Data directory resolution: the plugin host injects its private data directory
 * through the manifest env mapping; standalone runs fall back to a workspace
 * local directory so the server stays self-contained in tests and scripts.
 */
export function resolveNicheDataDir(env: NodeJS.ProcessEnv, cwd: string): string {
  const provided = env.YOUTUBE_NICHE_PLUGIN_DATA || env.ZCODE_PLUGIN_DATA;
  if (provided && provided.trim()) return provided;
  return join(cwd, ".youtube-niche");
}

type NicheRow = {
  id: number | bigint;
  name: string;
  notes: string;
  created_at: string;
  channel_count?: number | bigint;
  video_count?: number | bigint;
};

const toNiche = (row: NicheRow): NicheRecord => ({
  id: Number(row.id),
  name: String(row.name),
  notes: row.notes == null ? "" : String(row.notes),
  created_at: String(row.created_at),
  channel_count: Number(row.channel_count ?? 0),
  video_count: Number(row.video_count ?? 0),
});

type VideoRow = {
  video_id: string;
  title: string;
  channel_id: string | null;
  published_at: string | null;
  view_count: number | bigint | null;
  like_count: number | bigint | null;
  comment_count: number | bigint | null;
  duration_seconds: number | bigint | null;
  collected_at: string;
};

const toVideo = (row: VideoRow): VideoRecord => ({
  video_id: String(row.video_id),
  title: String(row.title),
  channel_id: row.channel_id == null ? null : String(row.channel_id),
  published_at: row.published_at == null ? null : String(row.published_at),
  view_count: row.view_count == null ? null : Number(row.view_count),
  like_count: row.like_count == null ? null : Number(row.like_count),
  comment_count: row.comment_count == null ? null : Number(row.comment_count),
  duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
  collected_at: String(row.collected_at),
});

/**
 * Opens (and creates on first use) the plugin's sqlite store. The channels and
 * videos tables land in this phase so later collection commits never need a
 * destructive migration; both cascade on niche removal.
 */
export function openNicheDatabase(dataDir: string): NicheDatabase {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DB_FILE_NAME));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec(
    `INSERT INTO plugin_meta(key, value) VALUES ('schema_version', '${DB_SCHEMA_VERSION}')
     ON CONFLICT(key) DO NOTHING`,
  );
  db.exec(`CREATE TABLE IF NOT EXISTS niches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    niche_id INTEGER NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    UNIQUE (niche_id, channel_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    niche_id INTEGER NOT NULL REFERENCES niches(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    channel_id TEXT,
    title TEXT NOT NULL,
    published_at TEXT,
    view_count INTEGER,
    like_count INTEGER,
    comment_count INTEGER,
    duration_seconds INTEGER,
    collected_at TEXT NOT NULL,
    UNIQUE (niche_id, video_id)
  )`);

  const insert = db.prepare(
    "INSERT INTO niches(name, notes, created_at) VALUES (?, ?, ?)",
  );
  const byName = db.prepare("SELECT * FROM niches WHERE name = ?");
  const list = db.prepare(`SELECT niches.*,
      (SELECT COUNT(*) FROM channels WHERE channels.niche_id = niches.id) AS channel_count,
      (SELECT COUNT(*) FROM videos WHERE videos.niche_id = niches.id) AS video_count
    FROM niches ORDER BY created_at DESC, niches.id DESC`);
  const remove = db.prepare("DELETE FROM niches WHERE name = ?");
  const listVideosStmt = db.prepare(
    "SELECT * FROM videos WHERE niche_id = ? ORDER BY collected_at DESC, id DESC",
  );
  const upsertVideo = db.prepare(`INSERT INTO videos
      (niche_id, video_id, channel_id, title, published_at, view_count, like_count, comment_count, duration_seconds, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(niche_id, video_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      title = excluded.title,
      published_at = excluded.published_at,
      view_count = excluded.view_count,
      like_count = excluded.like_count,
      comment_count = excluded.comment_count,
      duration_seconds = excluded.duration_seconds,
      collected_at = excluded.collected_at`);

  return {
    addNiche(name, notes) {
      const existing = byName.get(name) as NicheRow | undefined;
      if (existing) throw new NicheExistsError(name);
      const safeNotes = notes ?? "";
      const created_at = new Date().toISOString();
      const result = insert.run(name, safeNotes, created_at);
      return {
        id: Number(result.lastInsertRowid),
        name,
        notes: safeNotes,
        created_at,
        channel_count: 0,
        video_count: 0,
      };
    },
    getNiche(name) {
      const row = byName.get(name) as NicheRow | undefined;
      return row ? toNiche(row) : undefined;
    },
    listNiches() {
      return (list.all() as NicheRow[]).map(toNiche);
    },
    removeNiche(name) {
      return remove.run(name).changes > 0;
    },
    addVideo(nicheId, video) {
      return (
        upsertVideo.run(
          nicheId,
          video.video_id,
          video.channel_id,
          video.title,
          video.published_at,
          video.view_count,
          video.like_count,
          video.comment_count,
          video.duration_seconds,
          video.collected_at,
        ).changes > 0
      );
    },
    listVideos(nicheId) {
      return (listVideosStmt.all(nicheId) as VideoRow[]).map(toVideo);
    },
    close() {
      db.close();
    },
  };
}
