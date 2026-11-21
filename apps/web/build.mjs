// Bundles the Hono app into dist/_worker.js (Cloudflare Pages advanced mode).
// Version and commit are baked in at build time; nothing secret is embedded.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
writeFileSync("dist/_routes.json", JSON.stringify({ version: 1, include: ["/*"], exclude: [] }));
console.log(`built dist/_worker.js version=${pkg.version} commit=${commit.slice(0, 12)}`);
