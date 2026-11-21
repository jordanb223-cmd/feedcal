#!/usr/bin/env node
// Loads ZIP code centroids into public.zip_codes (Phase 13, D34).
// 1. Download and unzip the Census file yourself (about 1 MB):
//    https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip
// 2. Local:  node scripts/load-zcta.mjs 2024_Gaz_zcta_national.txt
//    Hosted: SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/load-zcta.mjs <file>
//    (Paste the key into your own terminal; it never goes in the repo.)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseGazetteer } from "./zcta.mjs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/load-zcta.mjs <path to 20xx_Gaz_zcta_national.txt>");
let url = process.env.SUPABASE_URL;
let key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  const s = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  url = s.API_URL;
  key = s.SERVICE_ROLE_KEY;
}
const rows = parseGazetteer(readFileSync(file, "utf8"));
console.log(`${rows.length} ZIP codes parsed`);
for (let i = 0; i < rows.length; i += 1000) {
  const res = await fetch(`${url}/rest/v1/zip_codes?on_conflict=zip`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.slice(i, i + 1000)),
  });
  if (!res.ok) throw new Error(`Batch at ${i} failed: ${res.status} ${await res.text()}`);
  process.stdout.write(".");
}
console.log("\ndone");
