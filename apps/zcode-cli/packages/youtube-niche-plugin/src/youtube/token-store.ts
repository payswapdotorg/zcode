import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Encrypted at-rest token store for the Google OAuth tokens, inside the
 * plugin's private data directory (never `userConfig`, which is plaintext —
 * environment-readiness report §3). The file is AES-256-GCM
 * (iv ‖ tag ‖ ciphertext, base64) keyed by a 32-byte key supplied via
 * YOUTUBE_NICHE_TOKEN_KEY; the production wrapper feeds that key from the OS
 * keychain the same way the desktop app wraps secrets, landing with R2.
 */
const TOKEN_FILE = "tokens.json.enc";
const AAD = "youtube-niche-tokens";

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** ISO timestamp when the access token expires. */
  expires_at: string;
  scope?: string;
}

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenStoreError";
  }
}

/** Decodes YOUTUBE_NICHE_TOKEN_KEY (base64, 32 bytes) or returns undefined. */
export function tokenKeyFromEnv(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env.YOUTUBE_NICHE_TOKEN_KEY;
  if (!raw || !raw.trim()) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new TokenStoreError("YOUTUBE_NICHE_TOKEN_KEY must be 32 bytes (base64)");
  return key;
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(AAD));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(key: Buffer, blob: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < 12 + 16) throw new TokenStoreError("token file is truncated");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(AAD));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenStoreError("token file failed authentication (wrong key or tampered file)");
  }
}

export function saveTokens(dataDir: string, key: Buffer, tokens: StoredTokens): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, TOKEN_FILE), encrypt(key, JSON.stringify(tokens)), "utf8");
}

export function loadTokens(dataDir: string, key: Buffer): StoredTokens | undefined {
  const path = join(dataDir, TOKEN_FILE);
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(decrypt(key, readFileSync(path, "utf8")));
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as StoredTokens).access_token !== "string") {
    throw new TokenStoreError("decrypted token file is not a StoredTokens payload");
  }
  return parsed as StoredTokens;
}
