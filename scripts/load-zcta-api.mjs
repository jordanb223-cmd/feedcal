#!/usr/bin/env node
// Loads the Census ZCTA gazetteer into a hosted project through Supabase's Management API
// ("run a query"), with the deploy's scoped access token (Database: read-write). Used by
// .github/workflows/zip-codes.yml, so nobody handles a service-role key.
//   SUPABASE_ACCESS_TOKEN=… SUPABASE_PROJECT_REF=… node scripts/load-zcta-api.mjs <file.txt>
import { readFileSync } from "node:fs";
import { parseGazetteer } from "./zcta.mjs";
import { AFTER_LOAD_SQL, zctaSqlBatches } from "./zcta-sql.mjs";

const file = process.argv[2];
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!file || !token || !ref) throw new Error("Usage: SUPABASE_ACCESS_TOKEN=… SUPABASE_PROJECT_REF=… node scripts/load-zcta-api.mjs <file>");

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const rows = parseGazetteer(readFileSync(file, "utf8"));
console.log(`${rows.length} ZIP codes parsed`);
const batches = zctaSqlBatches(rows);
for (const [i, sql] of batches.entries()) {
  await query(sql);
  console.log(`batch ${i + 1}/${batches.length}`);
}
await query(AFTER_LOAD_SQL);
console.log("zip_codes now:", JSON.stringify(await query("select count(*)::int as n from public.zip_codes;")));
