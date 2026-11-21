// Edge Function: deletes files queued in private.storage_trash, through the Storage API (SQL
// can't delete stored files). Called daily by pg_cron after private.expire_intake().
// It only deletes what the database already queued, so any caller with the public key is harmless.
import { admin, json, log } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const db = admin();
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const { data, error } = await db.rpc("claim_storage_trash", { p_limit: 100 });
    if (error) return json({ error: "Try again later." }, 503);
    const rows = (data ?? []) as { id: number; bucket: string; path: string }[];
    if (rows.length === 0) break;
    const byBucket = new Map<string, { ids: number[]; paths: string[] }>();
    for (const r of rows) {
      const b = byBucket.get(r.bucket) ?? { ids: [], paths: [] };
      b.ids.push(r.id);
      b.paths.push(r.path);
      byBucket.set(r.bucket, b);
    }
    for (const [bucket, { ids, paths }] of byBucket) {
      // remove() succeeds for paths that are already gone, so retries are safe.
      const { error: rmError } = await db.storage.from(bucket).remove(paths);
      if (rmError) {
        log("storage-trash", requestId, "remove_failed", { bucket, count: paths.length });
        return json({ removed, error: "Some files could not be removed; they stay queued." }, 503);
      }
      await db.rpc("forget_storage_trash", { p_ids: ids });
      removed += paths.length;
    }
  }
  log("storage-trash", requestId, "storage_trash_drained", { removed });
  return json({ removed, request_id: requestId });
});
