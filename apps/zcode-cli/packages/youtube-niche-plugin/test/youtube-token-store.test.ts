import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  TokenStoreError,
  loadTokens,
  saveTokens,
  tokenKeyFromEnv,
  type StoredTokens,
} from "#niche/youtube/token-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "youtube-niche-"));
  dirs.push(dir);
  return dir;
};

const tokens = (over: Partial<StoredTokens> = {}): StoredTokens => ({
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_at: "2026-11-17T12:00:00.000Z",
  scope: "https://www.googleapis.com/auth/youtube.readonly",
  ...over,
});

describe("tokenKeyFromEnv", () => {
  it("decodes a 32-byte base64 key and rejects anything else", () => {
    expect(tokenKeyFromEnv({})).toBeUndefined();
    expect(tokenKeyFromEnv({ YOUTUBE_NICHE_TOKEN_KEY: "  " })).toBeUndefined();
    const key = randomBytes(32);
    expect(tokenKeyFromEnv({ YOUTUBE_NICHE_TOKEN_KEY: key.toString("base64") })).toEqual(key);
    expect(() => tokenKeyFromEnv({ YOUTUBE_NICHE_TOKEN_KEY: randomBytes(16).toString("base64") })).toThrow(
      TokenStoreError,
    );
  });
});

describe("token store", () => {
  it("round-trips tokens encrypted at rest", () => {
    const dir = openDir();
    const key = randomBytes(32);
    saveTokens(dir, key, tokens());
    const stored = readFileSync(join(dir, "tokens.json.enc"), "utf8");
    expect(stored).not.toContain("at-1");
    expect(stored).not.toContain("rt-1");
    expect(loadTokens(dir, key)).toEqual(tokens());
  });

  it("returns undefined when no tokens were saved", () => {
    const dir = openDir();
    expect(loadTokens(dir, randomBytes(32))).toBeUndefined();
  });

  it("detects tampering and wrong keys via the GCM tag", () => {
    const dir = openDir();
    const key = randomBytes(32);
    saveTokens(dir, key, tokens());

    const path = join(dir, "tokens.json.enc");
    const blob = Buffer.from(readFileSync(path, "utf8"), "base64");
    blob[blob.length - 1] ^= 0xff;
    writeFileSync(path, Buffer.from(blob).toString("base64"), "utf8");
    expect(() => loadTokens(dir, key)).toThrow(TokenStoreError);

    const other = openDir();
    saveTokens(other, key, tokens());
    expect(() => loadTokens(other, randomBytes(32))).toThrow(/authentication/);
  });
});
