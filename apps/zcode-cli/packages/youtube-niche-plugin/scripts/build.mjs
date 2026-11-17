import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bundles the plugin package in the current directory into its dist/:
// - the stdio MCP server as one self-contained ESM file
// - the Niche Explorer panel: src/panel.ts (ext-apps client + renderer)
//   bundled as an IIFE and inlined into ui/panel.html at the
//   /*__PANEL_BOOTSTRAP__*/ placeholder (office-runtime's pattern; the single
//   HTML resource stays well below the host's per-read limit).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgRoot, "dist");
const ui = join(dist, "ui");

await rm(dist, { recursive: true, force: true });
await mkdir(ui, { recursive: true });

await build({
  entryPoints: [join(pkgRoot, "src", "main.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  logLevel: "info",
});

const panel = await build({
  entryPoints: [join(pkgRoot, "src", "panel.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
});
const panelJs = Buffer.from(panel.outputFiles[0].contents).toString("utf8");
const shell = await readFile(join(pkgRoot, "ui", "panel.html"), "utf8");
const placeholder = "/*__PANEL_BOOTSTRAP__*/";
if (!shell.includes(placeholder)) throw new Error("panel.html is missing the bootstrap placeholder");
// Function replacement: the bundle contains `$` sequences that a plain string
// replacement would interpret as patterns.
await writeFile(join(ui, "panel.html"), shell.replace(placeholder, () => panelJs));

console.log(`built ${join(dist, "server.mjs")} and the inlined Niche Explorer panel`);
