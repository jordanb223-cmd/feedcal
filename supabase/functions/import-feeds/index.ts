// Edge Function: re-fetches imported public calendars daily (pg_cron), D34. HTTPS only, 15 s,
// 2 MB; a source that fails keeps its events and is retried tomorrow.
import { parseIcs } from "../_shared/importer/ics.ts";
import { admin, json, log } from "../_shared/http.ts";

const MAX_BYTES = 2 * 1024 * 1024;

async function fetchIcs(url: string): Promise<string> {
  if (!url.startsWith("https://")) throw new Error("not_https");
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Feedcal-Importer/1.0", accept: "text/calendar" }, redirect: "follow" });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("too_large");
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("too_large");
  if (!body.includes("BEGIN:VCALENDAR")) throw new Error("not_ics");
  return body;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
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
