// Edge Function: scheduled Gmail checks (D39), every 5 minutes from pg_cron; only connections whose
// next check is due are touched. Each check: the example first (once), then one search for mail
// FROM the confirmed sender since the last check. Safe for the scheduler's anon key: it only does
// due work.
import { ReconnectError, runCheck } from "../_shared/gmail.ts";
import { ingestRaw } from "../_shared/gmail-ingest.ts";
import { admin, carriesUser, json, log, notScheduler } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (carriesUser(req)) return notScheduler();
  const clientId = Deno.env.get("GMAIL_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  if (!clientId || !clientSecret) return json({ checked: 0, configured: false });
  const db = admin();
  const { data, error } = await db.rpc("gmail_claim_checks", { p_limit: 3 });
  if (error) return json({ error: "Try again later." }, 503);
  let checked = 0;
  for (const c of (data ?? []) as { feed_id: string; intake_local_part: string; refresh_token: string | null; sender_email: string; example_gmail_id: string | null; last_checked_at: string | null }[]) {
    try {
      if (!c.refresh_token) throw new ReconnectError("no_token");
      const r = await runCheck({ refreshToken: c.refresh_token, sender: c.sender_email, exampleId: c.example_gmail_id,
        lastCheckedAt: new Date(c.last_checked_at ?? Date.now() - 86_400_000) }, {
        fetch, clientId, clientSecret, now: () => new Date(),
        seen: async (ids) => ((await db.rpc("gmail_seen", { p_feed_id: c.feed_id, p_gmail_ids: ids })).data ?? []) as string[],
        ingest: (raw) => ingestRaw(db, c.intake_local_part, raw),
        record: async (id, outcome, messageId) => { await db.rpc("gmail_record", { p_feed_id: c.feed_id, p_gmail_id: id, p_message_id: messageId, p_outcome: outcome }); },
      });
      await db.rpc("gmail_check_done", { p_feed_id: c.feed_id, p_checked_at: r.checkedAt.toISOString(), p_more: r.more });
      log("gmail-poll", requestId, "gmail_checked", { feed_id: c.feed_id, ingested: r.ingested, more: r.more });
      checked++;
    } catch (e) {
      const reconnect = e instanceof ReconnectError;
      await db.rpc("gmail_check_done", { p_feed_id: c.feed_id, p_checked_at: new Date().toISOString(),
        p_error: reconnect ? "invalid_grant" : (e instanceof Error ? e.message : "unknown"), p_reconnect: reconnect });
      log("gmail-poll", requestId, "gmail_check_failed", { feed_id: c.feed_id, reconnect });
    }
  }
  return json({ checked });
});
