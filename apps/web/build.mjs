// Bundles the Hono app into dist/_worker.js (Cloudflare Pages advanced mode).
// Version and commit are baked in at build time; nothing secret is embedded.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
let commit = process.env.GITHUB_SHA ?? "";
if (!commit) {
  try { commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { commit = "unknown"; }
}

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  mainFields: ["module", "main"],
  outfile: "dist/_worker.js",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(commit),
  },
});
// The one web font (the headline face, DESIGN.md) is a static file: Pages serves /fonts/* itself,
// so it never costs a Worker request. It comes from the pinned @fontsource package (OFL-1.1).
mkdirSync("dist/fonts", { recursive: true });
copyFileSync(new URL("../../node_modules/@fontsource/young-serif/files/young-serif-latin-400-normal.woff2", import.meta.url), "dist/fonts/young-serif-latin-400.woff2");
writeFileSync("dist/_headers", "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n");
writeFileSync("dist/_routes.json", JSON.stringify({ version: 1, include: ["/*"], exclude: ["/fonts/*"] }));
console.log(`built dist/_worker.js version=${pkg.version} commit=${commit.slice(0, 12)}`);
