// Edge Function: Buy Me a Coffee webhook (D36). Verifies the signature (BMC_WEBHOOK_SECRET),
// records each event once (event_id), and answers 200 quickly so BMC doesn't retry needlessly.
// Dashboard test events count only where BMC_ACCEPT_TEST_EVENTS=true (staging).
import { BmcEvent, signatureValid, supporterOf } from "../_shared/bmc.ts";
import { admin, json, log } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const raw = await req.text();
  if (raw.length > 100_000) return json({ error: "Too large." }, 413);
  if (!(await signatureValid(Deno.env.get("BMC_WEBHOOK_SECRET"), raw, req.headers.get("x-signature-sha256")))) {
    log("bmc-webhook", requestId, "bad_signature");
    return json({ error: "Bad signature." }, 401);
  }
  let parsed;
  try {
    parsed = BmcEvent.safeParse(JSON.parse(raw));
  } catch {
    return json({ error: "Bad JSON." }, 400);
  }
  if (!parsed.success) return json({ error: "Unexpected payload." }, 400);
  const e = parsed.data;
  const s = supporterOf(e.data);
  const { data, error } = await admin().rpc("record_bmc_event", {
    p_event_id: e.event_id, p_type: e.type, p_live: e.live_mode, p_email: s.email, p_name: s.name,
    p_amount_cents: s.amountCents, p_currency: s.currency, p_accept_test: Deno.env.get("BMC_ACCEPT_TEST_EVENTS") === "true",
  } as never);
  if (error) return json({ error: "Try again later." }, 503); // BMC retries
  // Event id, type and outcome only; never the supporter's name, email or note.
  log("bmc-webhook", requestId, "bmc_event", { event_id: e.event_id, type: e.type, live: e.live_mode, outcome: data });
  return json({ ok: true, outcome: data });
});
