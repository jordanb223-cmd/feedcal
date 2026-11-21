// Where email goes: Resend when RESEND_API_KEY is set (needs a verified domain), Mailpit locally
// (MAILPIT_URL), otherwise nowhere: mail stays queued ("held") until a provider is configured.
export interface Outgoing { to: string; from: string; subject: string; text: string; html: string; headers: Record<string, string>; idempotencyKey: string }
export interface Sender { name: string; send(m: Outgoing): Promise<{ ok: boolean; id?: string; error?: string }> }

export function resend(apiKey: string, fetcher: typeof fetch = fetch): Sender {
  return {
    name: "resend",
    async send(m) {
      // POST https://api.resend.com/emails, Bearer auth, {from,to,subject,html,text} → {id} (Resend API docs, checked 2026-11-21).
      // The "headers" field and the Idempotency-Key header name are UNVERIFIED (not in the quoted doc excerpt).
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey },
        body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, headers: m.headers }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      return res.ok ? { ok: true, ...(body.id ? { id: body.id } : {}) } : { ok: false, error: `resend ${res.status}` };
    },
  };
}

export function mailpit(baseUrl: string, fetcher: typeof fetch = fetch): Sender {
  return {
    name: "mailpit",
    async send(m) {
      const res = await fetcher(`${baseUrl.replace(/\/$/, "")}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ From: { Email: m.from.replace(/^.*<|>$/g, "") }, To: [{ Email: m.to }], Subject: m.subject, Text: m.text, HTML: m.html, Headers: m.headers }),
      });
      const body = (await res.json().catch(() => ({}))) as { ID?: string };
      return res.ok ? { ok: true, ...(body.ID ? { id: body.ID } : {}) } : { ok: false, error: `mailpit ${res.status}` };
    },
  };
}
