// Edge Function: fetches imported calendar links (pg_cron every 10 minutes; each link at most once
// per 20 hours), D34/D48. Safe fetch in _shared/importer/fetch.ts. A source that fails keeps its
// events and is retried later.
import { parseIcs } from "../_shared/importer/ics.ts";
import { fetchIcs } from "../_shared/importer/fetch.ts";
import { admin, carriesUser, json, log, notScheduler } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (carriesUser(req)) return notScheduler();
  const db = admin();
  const { data: rows, error } = await db.rpc("claim_imports", { p_limit: 20 });
  if (error) return json({ error: "Try again later." }, 503);
  let ok = 0;
  let failed = 0;
  for (const r of (rows ?? []) as { feed_id: string; url: string; timezone: string }[]) {
    try {
      const events = parseIcs(await fetchIcs(r.url), r.timezone);
      const { error: recError } = await db.rpc("record_import", { p_feed_id: r.feed_id, p_events: events });
      if (recError) throw new Error("record_failed");
      ok++;
      log("import-feeds", requestId, "feed_imported", { feed_id: r.feed_id, events: events.length });
    } catch (e) {
      failed++;
      log("import-feeds", requestId, "import_failed", { feed_id: r.feed_id, error: e instanceof Error ? e.message : "unknown" });
    }
  }
  return json({ ok, failed, request_id: requestId });
});
