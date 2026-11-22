// Edge Function: revoke the owner's Gmail token with Google before disconnecting (D51). Called by
// the web app with the owner's own session; ownership is checked as that user first. The token
// goes in a form body, never a URL. Best effort: disconnecting goes ahead either way (the Vault
// copy is deleted, and test-mode tokens expire within 7 days).
import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { z } from "npm:zod@4.6.7";
import { revokeToken } from "../_shared/gmail.ts";
import { admin, json, log } from "../_shared/http.ts";

const Body = z.object({ feed_id: z.uuid() });

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Bad request." }, 400);
  const asUser = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { error: notOwner } = await asUser.rpc("gmail_status", { p_feed_id: parsed.data.feed_id });
  if (notOwner) return json({ error: "Not allowed." }, 403);
  const { data: refresh } = await admin().rpc("gmail_token", { p_feed_id: parsed.data.feed_id });
  if (!refresh) return json({ revoked: false, reason: "no_token" });
  let revoked = false;
  try {
    revoked = await revokeToken(fetch, refresh as string);
  } catch {
    revoked = false;
  }
  log("gmail-revoke", requestId, "gmail_revoked", { feed_id: parsed.data.feed_id, revoked });  // never the token
  return json({ revoked });
});
