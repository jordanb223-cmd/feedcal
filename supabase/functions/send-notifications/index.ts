// Edge Function: sends queued notification emails (D33), every minute via pg_cron.
// Provider: Resend (RESEND_API_KEY + EMAIL_FROM), else Mailpit (MAILPIT_URL, local), else none:
// mail stays queued until one is configured. Logs ids and kinds only, never addresses or content.
import { mailpit, resend, type Sender } from "../_shared/notify/sender.ts";
import { type Kind, render, NO_UNSUBSCRIBE, safeReplyTo } from "../_shared/notify/templates.ts";
import { admin, carriesUser, json, log, notScheduler } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (carriesUser(req)) return notScheduler();
  const site = (Deno.env.get("SITE_URL") ?? "http://localhost:8788").replace(/\/$/, "");
  const from = Deno.env.get("EMAIL_FROM") ?? "Calantern <notifications@feedcal.test>";
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const mailpitUrl = Deno.env.get("MAILPIT_URL");
  const sender: Sender | null = resendKey ? resend(resendKey) : mailpitUrl ? mailpit(mailpitUrl) : null;
  if (!sender) {
    log("send-notifications", requestId, "no_provider");
    return json({ sent: 0, held: true, request_id: requestId });
  }
  const db = admin();
  const { data: rows, error } = await db.rpc("claim_outbox", { p_limit: 20 });
  if (error) return json({ error: "Try again later." }, 503);
  let sent = 0;
  let failed = 0;
  for (const r of (rows ?? []) as { id: string; kind: Kind; payload: Record<string, unknown>; email: string | null; user_id: string; unsubscribe_token: string }[]) {
    if (!r.email) {
      await db.rpc("mark_outbox", { p_id: r.id, p_sent: false, p_error: "no_email" });
      failed++;
      continue;
    }
    const unsubscribe = `${site}/unsubscribe?u=${r.user_id}&k=${r.kind}&t=${r.unsubscribe_token}`;
    const m = render(r.kind, r.payload, site, unsubscribe);
    const result = await sender.send({
      to: r.email, from, subject: m.subject, text: m.text, html: m.html, idempotencyKey: r.id,
      // RFC 8058 one-click unsubscribe: mail apps POST to this URL. Admin alerts have none (D38).
      headers: {
        ...(NO_UNSUBSCRIBE.has(r.kind) ? {} : { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }),
        ...(safeReplyTo(m.replyTo) ? { "Reply-To": m.replyTo as string } : {}),  // D63: answer the sender of a contact message
      },
    }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : "send_failed" }));
    await db.rpc("mark_outbox", { p_id: r.id, p_sent: result.ok, ...("id" in result && result.id ? { p_provider_id: result.id } : {}), ...(result.ok ? {} : { p_error: result.error ?? "failed" }) });
    if (result.ok) sent++; else failed++;
  }
  log("send-notifications", requestId, "batch_done", { provider: sender.name, sent, failed });
  return json({ sent, failed, provider: sender.name, request_id: requestId });
});
