#!/usr/bin/env node
// Safety guard (D57): `npm run db:reset` wipes the LOCAL database and re-applies migrations.
// Flags that point it at a hosted project (--linked, --db-url) are refused, so a stray
// `npm run db:reset -- --linked` can't wipe staging or production.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const remote = args.find((a) => a === "--linked" || a.startsWith("--db-url") || a.startsWith("--project-ref"));
if (remote) {
  process.stderr.write(`REFUSING: "${remote.split("=")[0]}" would reset a HOSTED database and DELETE all its data. db:reset is for the local stack only.\n`);
  process.exit(1);
}
console.log("WARNING: wiping ALL data in the LOCAL database and re-applying migrations…");
const r = spawnSync("npx", ["supabase", "db", "reset", ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
