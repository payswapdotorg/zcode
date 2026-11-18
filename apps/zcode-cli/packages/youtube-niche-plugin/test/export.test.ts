import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NicheRecord, VideoRecord } from "#niche/contract.ts";
import { openNicheDatabase, type NicheDatabase } from "#niche/db.ts";
import { exportNiche, slugifyNiche, toCsv, toMarkdown } from "#niche/export.ts";
import { rankVideos, type ScoredVideo } from "#niche/ranking.ts";

const NOW = new Date("2026-11-18T11:00:00Z");

const video = (overrides: Partial<VideoRecord> = {}): VideoRecord => ({
  video_id: "v1",
  title: "Espresso 101",
  channel_id: "c1",
  published_at: "2026-11-11T00:00:00Z",
  view_count: 5000,
  like_count: 200,
  comment_count: 50,
  duration_seconds: 480,
  collected_at: "2026-11-17T00:00:00Z",
  ...overrides,
});

const scored = (videos: readonly VideoRecord[]): ScoredVideo[] => rankVideos(videos, NOW);

describe("export formatting", () => {
  it("escapes CSV separators, quotes and newlines (RFC 4180)", () => {
    const rows = scored([
      video({ title: 'Best "grinders", ranked\n(new line)' }),
      video({ video_id: "v2", title: "Plain title", view_count: 100, like_count: 1, comment_count: 0 }),
    ]);
    const csv = toCsv(rows);
    expect(csv.trimEnd().split("\n")[0]).toBe(
      "rank,video_id,title,channel_id,published_at,view_count,like_count,comment_count,duration_seconds,views_per_day,engagement_rate,score",
    );
    // The quoted field keeps its embedded newline; the row spans two physical lines.
    expect(csv).toContain('"Best ""grinders"", ranked\n(new line)"');
    expect(csv).toContain("Plain title");
    expect(csv.trimEnd().split("\n")).toHaveLength(4);
  });

  it("emits ranked rows with score, views/day and engagement", () => {
    const rows = scored([
      video({ video_id: "slow", view_count: 10 }),
      video({ video_id: "fast", view_count: 100000, like_count: 5000, comment_count: 1000 }),
    ]);
    const csv = toCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[1]).toMatch(/^1,fast,/);
    expect(lines[2]).toMatch(/^2,slow,/);
    // engagement = (5000 + 1000) / 100000; views/day over the real age in days.
    const ageDays =
      (NOW.getTime() - new Date("2026-11-11T00:00:00Z").getTime()) / (24 * 60 * 60 * 1000);
    expect(lines[1]).toContain(`,${Math.round(100000 / ageDays)},0.0600,`);
    expect(lines[1]).toMatch(/,\d\.\d{4}$/);
  });

  it("escapes pipes and newlines in Markdown cells and keeps the table intact", () => {
    const rows = scored([video({ title: "A|B\nC" })]);
    const md = toMarkdown({ id: 1, name: "espresso", notes: "", created_at: "2026-11-17T00:00:00Z", channel_count: 1, video_count: 1 }, rows, NOW);
    const lines = md.split("\n");
    expect(lines[0]).toBe("# espresso — collected videos");
    expect(md).toContain("A\\|B C");
    expect(md).toContain("| # | title | channel | published | views | likes | comments | views/day | score |");
  });

  it("sanitizes niche names into filesystem-safe slugs", () => {
    expect(slugifyNiche("Budget Home Espresso")).toBe("budget-home-espresso");
    expect(slugifyNiche("../../etc/passwd")).toBe("etc-passwd");
    expect(slugifyNiche("手冲 咖啡!")).toBe("手冲-咖啡");
    expect(slugifyNiche("???")).toBe("niche");
    expect(slugifyNiche("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe("exportNiche", () => {
  const dirs: string[] = [];
  const databases: NicheDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const niche = (name: string): NicheRecord & { dataDir: string } => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-export-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    return { ...db.addNiche(name), dataDir };
  };

  it("writes a ranked CSV into the exports directory", () => {
    const { id, name, dataDir } = niche("budget home espresso");
    const db = databases[databases.length - 1]!;
    db.addVideo(id, video({ title: "V1" }));
    db.addVideo(id, video({ video_id: "v2", title: "V2", view_count: 100000 }));
    const result = exportNiche({ db, niche: { id, name, notes: "", created_at: "", channel_count: 0, video_count: 2 }, format: "csv", dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(/exports\/niche-budget-home-espresso-20261118-1100\.csv$/);
    expect(result.rows).toBe(2);
    const content = readFileSync(result.path, "utf8");
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(content.split("\n")[0]).toContain("video_id");
    expect(content).toContain("V1");
  });

  it("re-exports to the same minute-stamped file (idempotent, no litter)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-export-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    const record = db.addNiche("espresso");
    db.addVideo(record.id, video());
    const nicheRecord = { ...record, channel_count: 0, video_count: 1 };
    const first = exportNiche({ db, niche: nicheRecord, format: "markdown", dataDir, now: NOW });
    const second = exportNiche({ db, niche: nicheRecord, format: "markdown", dataDir, now: NOW });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.path).toBe(first.path);
  });

  it("refuses honestly when the niche has no collected videos", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-export-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    const record = db.addNiche("empty niche");
    const result = exportNiche({
      db,
      niche: { ...record, channel_count: 0, video_count: 0 },
      format: "csv",
      dataDir,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toMatch(/No videos collected/);
  });

  it("respects the limit (top-ranked rows only)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-export-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    const record = db.addNiche("limited");
    for (let i = 1; i <= 5; i++)
      db.addVideo(record.id, video({ video_id: `v${i}`, view_count: i * 1000 }));
    const result = exportNiche({
      db,
      niche: { ...record, channel_count: 0, video_count: 5 },
      format: "csv",
      limit: 2,
      dataDir,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, rows: 2 });
  });
});
