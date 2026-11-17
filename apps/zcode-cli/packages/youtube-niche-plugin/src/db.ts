import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME, DB_SCHEMA_VERSION, type NicheRecord } from "#niche/contract.ts";

export class NicheExistsError extends Error {
  constructor(name: string) {
    super(`niche already tracked: ${name}`);
    this.name = "NicheExistsError";
  }
}

export interface NicheDatabase {
  addNiche(name: string, notes?: string): NicheRecord;
  listNiches(): NicheRecord[];
  removeNiche(name: string): boolean;
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
    listNiches() {
      return (list.all() as NicheRow[]).map(toNiche);
    },
    removeNiche(name) {
      return remove.run(name).changes > 0;
    },
    close() {
      db.close();
    },
  };
}
