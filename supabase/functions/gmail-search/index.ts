// Edge Function: the owner's example search (D39). Called by the web app with the owner's own
// session; ownership is checked as that user before the token is used. Returns at most 10
// results (sender, subject, date) and keeps them so the owner can pick one.
import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { z } from "npm:zod@4.6.7";
import { accessToken, ReconnectError, searchExamples } from "../_shared/gmail.ts";
import { admin, json, log } from "../_shared/http.ts";

const Body = z.object({ feed_id: z.uuid(), words: z.string().trim().min(2).max(100) });

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Type at least two letters." }, 400);
  const asUser = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { error: notOwner } = await asUser.rpc("gmail_status", { p_feed_id: parsed.data.feed_id });
  if (notOwner) return json({ error: "Not allowed." }, 403);
  const db = admin();
  const { data: refresh } = await db.rpc("gmail_token", { p_feed_id: parsed.data.feed_id });
  if (!refresh) return json({ error: "Connect Gmail first." }, 409);
  try {
    const token = await accessToken(fetch, Deno.env.get("GMAIL_CLIENT_ID") ?? "", Deno.env.get("GMAIL_CLIENT_SECRET") ?? "", refresh as string);
    const candidates = await searchExamples(fetch, token, parsed.data.words);
    await db.rpc("gmail_save_candidates", { p_feed_id: parsed.data.feed_id, p_candidates: candidates });
    log("gmail-search", requestId, "example_search", { feed_id: parsed.data.feed_id, results: candidates.length });  // never the words or results
    return json({ candidates });
  } catch (e) {
    if (e instanceof ReconnectError) {
      await db.rpc("gmail_check_done", { p_feed_id: parsed.data.feed_id, p_checked_at: new Date().toISOString(), p_error: "invalid_grant", p_reconnect: true });
      return json({ error: "Reconnect Gmail." }, 409);
    }
    log("gmail-search", requestId, "example_search_failed", { error: e instanceof Error ? e.message : "unknown" });
    return json({ error: "Try again in a minute." }, 503);
  }
});
