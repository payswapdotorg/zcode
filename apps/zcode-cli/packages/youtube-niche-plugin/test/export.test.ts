import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NicheRecord, VideoRecord } from "#niche/contract.ts";
import { openNicheDatabase, type NicheDatabase } from "#niche/db.ts";
import {
  exportComparison,
  exportNiche,
  pruneExports,
  readScheduleMarker,
  runScheduledExports,
  shouldRunScheduledExports,
  slugifyNiche,
  toCsv,
  toMarkdown,
} from "#niche/export.ts";
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

describe("comparison export", () => {
  const dirs: string[] = [];
  const databases: NicheDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const openDb = (): { db: NicheDatabase; dataDir: string } => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-compare-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    return { db, dataDir };
  };

  /** "hot espresso" accelerating (two snapshots), "cold brew, iced" unclassified (one). */
  const seed = (db: NicheDatabase): void => {
    const hot = db.addNiche("hot espresso");
    db.addVideo(
      hot.id,
      video({
        video_id: "h1",
        title: "Hot one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 1000,
        collected_at: "2026-11-15T00:00:00Z",
      }),
    );
    db.addVideo(
      hot.id,
      video({
        video_id: "h1",
        title: "Hot one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 6000,
        like_count: 300,
        comment_count: 100,
        collected_at: "2026-11-18T00:00:00Z",
      }),
    );
    const cold = db.addNiche("cold brew, iced");
    db.addVideo(
      cold.id,
      video({
        video_id: "c1",
        title: "Cold one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 3000,
        like_count: 90,
        comment_count: 30,
        collected_at: "2026-11-18T00:00:00Z",
      }),
    );
  };

  it("writes a ranked comparison CSV with momentum counts and heat", () => {
    const { db, dataDir } = openDb();
    seed(db);
    const result = exportComparison({ db, format: "csv", dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(/exports\/niche-compare-20261118-1100\.csv$/);
    expect(result.rows).toBe(2);
    const content = readFileSync(result.path, "utf8");
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(content.split("\n")[0]).toBe(
      "rank,niche,video_count,total_views,views_per_day,engagement_rate,accelerating,steady,cooling,insufficient,heat,score",
    );
    // hot: 1 video, 6000 views, 1 accelerating, heat 1, composite 1.0.
    expect(content).toContain("1,hot espresso,1,6000,");
    expect(content).toContain("1,0,0,0,1.0000,1.0000");
    // cold: nothing classified → empty heat cell; comma in the niche name is quoted.
    expect(content).toContain('"cold brew, iced"');
    expect(content).toContain("0,0,0,1,,0.3200");
  });

  it("writes a Markdown comparison with top movers", () => {
    const { db, dataDir } = openDb();
    seed(db);
    const result = exportComparison({ db, format: "markdown", dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("# Cross-niche comparison");
    expect(content).toContain("| # | niche | videos | total views | views/day | engagement |");
    expect(content).toContain("| 1 | hot espresso | 1 | 6000 |");
    expect(content).toContain("## Top movers");
    expect(content).toContain("- **hot espresso**: Hot one (accelerating, 2.9×)");
    // Unclassified heat stays an em dash in the table.
    expect(content).toContain("| — | 0.3200 |");
  });

  it("refuses honestly below two tracked niches", () => {
    const { db, dataDir } = openDb();
    db.addNiche("lonely");
    const result = exportComparison({ db, format: "csv", dataDir, now: NOW });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toMatch(/at least 2 tracked niches \(currently 1\)/);
  });

  it("respects the limit (hottest niches only)", () => {
    const { db, dataDir } = openDb();
    seed(db);
    db.addNiche("third niche");
    const result = exportComparison({ db, format: "csv", limit: 2, dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBe(2);
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("hot espresso");
    expect(content).not.toContain("third niche");
  });
});

describe("report export", () => {
  const dirs: string[] = [];
  const databases: NicheDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const openDb = (): { db: NicheDatabase; dataDir: string } => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-report-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    return { db, dataDir };
  };

  /** "hot espresso" accelerating (two snapshots), "cold brew, iced" unclassified (one). */
  const seed = (db: NicheDatabase): void => {
    const hot = db.addNiche("hot espresso");
    db.addVideo(
      hot.id,
      video({
        video_id: "h1",
        title: "Hot one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 1000,
        collected_at: "2026-11-15T00:00:00Z",
      }),
    );
    db.addVideo(
      hot.id,
      video({
        video_id: "h1",
        title: "Hot one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 6000,
        like_count: 300,
        comment_count: 100,
        collected_at: "2026-11-18T00:00:00Z",
      }),
    );
    const cold = db.addNiche("cold brew, iced");
    db.addVideo(
      cold.id,
      video({
        video_id: "c1",
        title: "Cold one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 3000,
        like_count: 90,
        comment_count: 30,
        collected_at: "2026-11-18T00:00:00Z",
      }),
    );
  };

  it("composes a full report: momentum, ranked videos with trends, channels, position", () => {
    const { db, dataDir } = openDb();
    seed(db);
    const hot = db.listNiches().find((niche) => niche.name === "hot espresso")!;
    const result = exportNiche({ db, niche: hot, format: "report", dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(/exports\/niche-hot-espresso-report-20261118-1100\.md$/);
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("# hot espresso — niche report");
    expect(content).toContain("## Momentum");
    expect(content).toContain("1 accelerating · 0 steady · 0 cooling · 0 insufficient");
    expect(content).toContain("## Ranked videos");
    // Trend cell carries the class and the 2.9× ratio; single-video batch scores 1.0.
    expect(content).toContain("| 1 | Hot one | c1 | 2026-11-08 | 6000 | 574 | accelerating 2.9× | 1.0000 |");
    expect(content).toContain("## Top channels");
    expect(content).toContain("| 1 | c1 | 1 | 6000 | 574 | 6.7% | 1.0000 |");
    expect(content).toContain("## Cross-niche position");
    expect(content).toContain("**#1 of 2** tracked niches by composite score");
    expect(content).toContain('leader "hot espresso" at 1.00');
    expect(content).toContain("Heat: 100% accelerating share.");
  });

  it("keeps unclassified trends and a losing position honest", () => {
    const { db, dataDir } = openDb();
    seed(db);
    const cold = db.listNiches().find((niche) => niche.name === "cold brew, iced")!;
    const result = exportNiche({ db, niche: cold, format: "report", dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(/exports\/niche-cold-brew-iced-report-20261118-1100\.md$/);
    const content = readFileSync(result.path, "utf8");
    // Single snapshot → insufficient without a made-up ratio.
    expect(content).toContain("| insufficient | 1.0000 |");
    expect(content).toContain("**#2 of 2** tracked niches by composite score (0.32;");
    expect(content).toContain("Heat: no classified videos yet.");
  });

  it("reports an honest single-niche position line", () => {
    const { db, dataDir } = openDb();
    const lonely = db.addNiche("lonely");
    db.addVideo(lonely.id, video({ title: "Only one" }));
    const result = exportNiche({
      db,
      niche: { ...lonely, channel_count: 0, video_count: 1 },
      format: "report",
      dataDir,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("Only this niche is tracked");
    expect(content).not.toContain("**#1 of");
  });
});

describe("scheduled exports", () => {
  const dirs: string[] = [];
  const databases: NicheDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const openDb = (): { db: NicheDatabase; dataDir: string } => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-schedule-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    databases.push(db);
    return { db, dataDir };
  };

  it("reads a missing, corrupt or shape-invalid marker as never-run", () => {
    const { dataDir } = openDb();
    expect(readScheduleMarker(dataDir)).toEqual({ lastRun: null });
    writeFileSync(join(dataDir, "schedule.json"), "{not json", "utf8");
    expect(readScheduleMarker(dataDir)).toEqual({ lastRun: null });
    writeFileSync(join(dataDir, "schedule.json"), JSON.stringify({ lastRun: 42 }), "utf8");
    expect(readScheduleMarker(dataDir)).toEqual({ lastRun: null });
  });

  it("runs only once the interval elapsed", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(shouldRunScheduledExports({ lastRun: null }, now)).toBe(true);
    // 1h ago with the default 24h interval → not yet.
    expect(shouldRunScheduledExports({ lastRun: "2026-11-18T11:00:00Z" }, now)).toBe(false);
    // 24h1m ago → due.
    expect(shouldRunScheduledExports({ lastRun: "2026-11-17T11:59:00Z" }, now)).toBe(true);
    // A custom 1h interval flips the recent marker to due.
    expect(shouldRunScheduledExports({ lastRun: "2026-11-18T11:00:00Z" }, now, 1)).toBe(true);
    // A garbage date cannot prove a recent run → run again.
    expect(shouldRunScheduledExports({ lastRun: "garbage" }, now)).toBe(true);
  });

  it("writes a report per niche with videos and stamps the marker", () => {
    const { db, dataDir } = openDb();
    const hot = db.addNiche("hot espresso");
    db.addVideo(
      hot.id,
      video({
        video_id: "h1",
        title: "Hot one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 1000,
        collected_at: "2026-11-15T00:00:00Z",
      }),
    );
    db.addVideo(
      hot.id,
      video({
        video_id: "h1",
        title: "Hot one",
        published_at: "2026-11-08T00:00:00Z",
        view_count: 6000,
        like_count: 300,
        comment_count: 100,
        collected_at: "2026-11-18T00:00:00Z",
      }),
    );
    db.addNiche("empty niche");
    const result = runScheduledExports({ db, dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written.map((row) => row.niche)).toEqual(["hot espresso"]);
    expect(result.skipped).toEqual(["empty niche"]);
    const content = readFileSync(result.written[0]!.path, "utf8");
    expect(content).toContain("# hot espresso — niche report");
    expect(readScheduleMarker(dataDir)).toEqual({ lastRun: NOW.toISOString() });
    // The stamped marker is fresh → the next check (24h default) skips.
    expect(shouldRunScheduledExports(readScheduleMarker(dataDir), NOW)).toBe(false);
  });

  it("does not stamp the marker when nothing was written", () => {
    const { db, dataDir } = openDb();
    db.addNiche("empty niche");
    const result = runScheduledExports({ db, dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(["empty niche"]);
    // No report → no marker: the next check still considers a run due.
    expect(readScheduleMarker(dataDir)).toEqual({ lastRun: null });
    expect(shouldRunScheduledExports(readScheduleMarker(dataDir), NOW)).toBe(true);
  });
});

describe("export retention", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const openExportsDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "niche-prune-"));
    dirs.push(dir);
    return dir;
  };

  const touch = (dir: string, name: string): void => {
    writeFileSync(join(dir, name), "x", "utf8");
  };

  it("keeps the newest 30 per group and never touches foreign files", () => {
    const dir = openExportsDir();
    for (let i = 0; i < 35; i++)
      touch(dir, `niche-espresso-report-20261117-${String(i).padStart(4, "0")}.md`);
    touch(dir, "niche-espresso-20261117-0001.csv");
    touch(dir, "niche-espresso-20261117-0002.csv");
    touch(dir, "niche-espresso-20261117-0003.md");
    touch(dir, "niche-compare-20261117-0001.csv");
    touch(dir, "niche-compare-20261117-0001.md");
    touch(dir, "notes.txt");
    touch(dir, "random.md");
    touch(dir, "niche-bad.txt");
    const { deleted } = pruneExports({ exportsDir: dir });
    // Only the 5 oldest espresso reports went; csv/md/compare groups sit far
    // below the retention and foreign files are not ours to delete.
    expect(deleted).toEqual([
      "niche-espresso-report-20261117-0000.md",
      "niche-espresso-report-20261117-0001.md",
      "niche-espresso-report-20261117-0002.md",
      "niche-espresso-report-20261117-0003.md",
      "niche-espresso-report-20261117-0004.md",
    ]);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toHaveLength(38);
    expect(remaining).toContain("notes.txt");
    expect(remaining).toContain("niche-compare-20261117-0001.csv");
    expect(remaining).toContain("niche-espresso-report-20261117-0034.md");
  });

  it("prunes each group independently with a custom keep", () => {
    const dir = openExportsDir();
    for (const stamp of ["20261117-0100", "20261117-0200", "20261117-0300"]) {
      touch(dir, `niche-a-${stamp}.csv`);
      touch(dir, `niche-b-${stamp}.csv`);
    }
    const { deleted } = pruneExports({ exportsDir: dir, keep: 2 });
    expect(deleted).toEqual(["niche-a-20261117-0100.csv", "niche-b-20261117-0100.csv"]);
    expect(readdirSync(dir).sort()).toEqual([
      "niche-a-20261117-0200.csv",
      "niche-a-20261117-0300.csv",
      "niche-b-20261117-0200.csv",
      "niche-b-20261117-0300.csv",
    ]);
  });

  it("keeps everything at or below the retention and tolerates a missing directory", () => {
    const dir = openExportsDir();
    touch(dir, "niche-a-20261117-0100.csv");
    touch(dir, "niche-a-20261117-0200.csv");
    touch(dir, "niche-compare-20261117-0100.md");
    expect(pruneExports({ exportsDir: dir }).deleted).toEqual([]);
    expect(pruneExports({ exportsDir: join(dir, "nope") }).deleted).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it("a scheduled pass prunes old reports after writing the new one", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "niche-prune-run-"));
    dirs.push(dataDir);
    const db = openNicheDatabase(dataDir);
    const hot = db.addNiche("hot espresso");
    db.addVideo(
      hot.id,
      video({ title: "Hot one", view_count: 6000, collected_at: "2026-11-18T00:00:00Z" }),
    );
    const exportsDir = join(dataDir, "exports");
    mkdirSync(exportsDir, { recursive: true });
    // 39 stale reports from yesterday plus one an hour before NOW.
    for (let i = 0; i < 39; i++)
      touch(exportsDir, `niche-hot-espresso-report-20261117-${String(i).padStart(4, "0")}.md`);
    touch(exportsDir, "niche-hot-espresso-report-20261118-1059.md");
    const result = runScheduledExports({ db, dataDir, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 41 reports in the group → keep 30: the 11 oldest yesterday files go.
    expect(result.pruned).toHaveLength(11);
    const reports = readdirSync(exportsDir).filter((name) => name.includes("-report-"));
    expect(reports).toHaveLength(30);
    expect(reports).toContain("niche-hot-espresso-report-20261118-1100.md");
    db.close();
  });
});
