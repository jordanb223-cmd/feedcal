// Edge Function: after the Worker uploads the raw email, read its headers (never in the Worker),
// then record it in SQL: dedupe, sender allowlist, quarantine, Gmail confirmation, enqueue.
// Safe to call twice for the same ticket.
import { z } from "npm:zod@4.6.7";
import { byteaHex, commitFacts } from "../_shared/intake.ts";
import { admin, json, log, signedBody } from "../_shared/http.ts";

const Body = z.object({ ticket: z.uuid(), path: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.eml$/) });
const MAX_BYTES = 20 * 1024 * 1024;

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const raw = await signedBody(req);
  if (raw === null) return json({ error: "Not allowed." }, 403);
  const parsed = Body.safeParse(JSON.parse(raw));
  if (!parsed.success) return json({ error: "Bad request." }, 400);
  const { ticket, path } = parsed.data;

  const db = admin();
  const file = await db.storage.from("inbound-raw").download(path);
  if (file.error || !file.data) {
    log("ingest-commit", requestId, "raw_missing", { ticket });
    return json({ ok: false, reject: "upload_missing" });
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const facts = bytes.length <= MAX_BYTES ? await commitFacts(bytes) : null;

  const { data, error } = await db.rpc("ingest_commit", {
    p_ticket: ticket,
    p_path: path,
    p_raw_bytes: bytes.length,
    p_message_id_header: facts?.messageId ?? null,
    p_sender: facts?.sender ?? null,
    p_subject: facts?.subject ?? null,
    p_body_sha256: facts ? byteaHex(facts.bodySha256) : null,
    p_attachment_count: facts?.attachmentCount ?? 0,
    p_spf: facts?.spf ?? null,
    p_dkim: facts?.dkim ?? null,
    p_dmarc: facts?.dmarc ?? null,
    p_gmail_confirmation: facts?.gmail ?? null,
  });
  if (error) {
    log("ingest-commit", requestId, "ingest_commit_failed", { code: error.code, ticket });
    return json({ error: "Try again later." }, 503);
  }
  const result = data as { ok: boolean; outcome?: string; reject?: string; delete_raw?: boolean };
  if (result.delete_raw) {
    // Also queued in storage_trash by SQL, so a failure here is retried by the daily job.
    await db.storage.from("inbound-raw").remove([path]);
  }
  log("ingest-commit", requestId, "ingest_committed", {
    ticket, outcome: result.outcome ?? null, reject: result.reject ?? null, bytes: bytes.length,
    attachments: facts?.attachmentCount ?? null, dmarc: facts?.dmarc ?? null,
  });
  return json({ ok: result.ok, outcome: result.outcome ?? null, reject: result.reject ?? null });
});
