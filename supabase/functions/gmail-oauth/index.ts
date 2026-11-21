// Edge Function: Google's redirect after "Connect Gmail" (D39). Checks the one-time state,
// exchanges the code with the PKCE verifier, stores the refresh token in Vault, and sends the owner
// back to the feed's Gmail page. No Supabase JWT here: Google calls it (verify_jwt = false).
import { exchangeCode, GMAIL_SCOPE, profileEmail } from "../_shared/gmail.ts";
import { admin, log } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  const site = (Deno.env.get("SITE_URL") ?? "http://localhost:8788").replace(/\/$/, "");
  const back = (feedId: string | null, result: string) =>
    Response.redirect(feedId ? `${site}/feeds/${feedId}/gmail?result=${result}` : `${site}/feeds?gmail=${result}`, 303);
  const state = url.searchParams.get("state") ?? "";
  const db = admin();
  const { data: v } = await db.rpc("gmail_oauth_verifier", { p_state: state });
  const found = v as { feed_id: string; code_verifier: string } | null;
  if (!found) return back(null, "expired");
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("error")) return back(found.feed_id, "cancelled");
  const clientId = Deno.env.get("GMAIL_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET") ?? "";
  const redirectUri = Deno.env.get("GMAIL_REDIRECT_URI") ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/gmail-oauth`;
  try {
    const tokens = await exchangeCode(fetch, { clientId, clientSecret, code, verifier: found.code_verifier, redirectUri });
    if (!tokens.refresh_token || !(tokens.scope ?? "").split(" ").includes(GMAIL_SCOPE)) return back(found.feed_id, "not_granted");
    const email = await profileEmail(fetch, tokens.access_token ?? "");
    const { data: feedId } = await db.rpc("gmail_oauth_complete", { p_state: state, p_google_email: email, p_refresh_token: tokens.refresh_token });
    log("gmail-oauth", requestId, "gmail_connected", { feed_id: feedId ?? null });
    return back(found.feed_id, feedId ? "connected" : "expired");
  } catch (e) {
    log("gmail-oauth", requestId, "gmail_connect_failed", { error: e instanceof Error ? e.message : "unknown" });
    return back(found.feed_id, "failed");
  }
});
