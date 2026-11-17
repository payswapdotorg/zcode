import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bundles the plugin package in the current directory into its dist/: the stdio
// MCP server as one self-contained ESM file, plus the panel asset the server
// serves at ui://youtube-niche/panel.html.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgRoot, "dist");
const ui = join(dist, "ui");

await rm(dist, { recursive: true, force: true });
await mkdir(ui, { recursive: true });
await cp(join(pkgRoot, "ui", "panel.html"), join(ui, "panel.html"));

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

console.log(`built ${join(dist, "server.mjs")} and panel assets`);
