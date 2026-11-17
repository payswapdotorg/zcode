/** Stable identities shared by the manifest, the MCP server and the panel. */
export const SERVER_NAME = "youtube-niche";
export const PLUGIN_VERSION = "0.1.0";
export const SURFACE_ID = "niche-explorer";
export const PANEL_URI = `ui://${SERVER_NAME}/panel.html`;
export const HTML_MIME = "text/html";

/** File name of the plugin's sqlite database inside its data directory. */
export const DB_FILE_NAME = "niche.db";
/** Schema version stamped into plugin_meta; migrations stay additive-only. */
export const DB_SCHEMA_VERSION = "1";

export interface NicheRecord {
  id: number;
  name: string;
  notes: string;
  created_at: string;
  channel_count: number;
  video_count: number;
}

/** One collected video snapshot; stats refresh on every re-collection (upsert). */
export interface VideoRecord {
  video_id: string;
  title: string;
  channel_id: string | null;
  published_at: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  duration_seconds: number | null;
  collected_at: string;
}
