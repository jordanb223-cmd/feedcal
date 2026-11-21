// Phase 17 (D39): puts one raw email from Gmail through the same intake as a forwarded email:
// ingest_start (address, size, daily cap) → upload to inbound-raw → ingest_commit (dedupe,
// new-sender check, quarantine, queue). Same steps as the Email Worker + ingest-commit.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.2";
import { byteaHex, commitFacts } from "./intake.ts";

const MAX_BYTES = 20 * 1024 * 1024;

export async function ingestRaw(db: SupabaseClient, localPart: string, raw: Uint8Array): Promise<{ outcome: string; messageId: string | null }> {
  if (raw.length > MAX_BYTES) return { outcome: "too_large", messageId: null };
  const { data: start, error: e1 } = await db.rpc("ingest_start", { p_local_part: localPart, p_bytes: raw.length });
  if (e1) throw new Error("ingest_start_failed");
  const s = start as { ok: boolean; ticket?: string; path?: string; reject?: string };
  if (!s.ok || !s.ticket || !s.path) return { outcome: s.reject ?? "rejected", messageId: null };
  const up = await db.storage.from("inbound-raw").upload(s.path, raw, { contentType: "message/rfc822", upsert: false });
  if (up.error) throw new Error("upload_failed");
  const facts = await commitFacts(raw);
  const { data, error } = await db.rpc("ingest_commit", {
    p_ticket: s.ticket, p_path: s.path, p_raw_bytes: raw.length, p_message_id_header: facts.messageId ?? null,
    p_sender: facts.sender ?? null, p_subject: facts.subject ?? null, p_body_sha256: byteaHex(facts.bodySha256),
    p_attachment_count: facts.attachmentCount, p_spf: facts.spf ?? null, p_dkim: facts.dkim ?? null, p_dmarc: facts.dmarc ?? null,
    p_gmail_confirmation: facts.gmail ?? null,
  });
  if (error) throw new Error("ingest_commit_failed");
  const r = data as { ok: boolean; outcome?: string; reject?: string; message_id?: string; delete_raw?: boolean };
  if (r.delete_raw) await db.storage.from("inbound-raw").remove([s.path]);
  return { outcome: r.outcome ?? r.reject ?? "unknown", messageId: r.message_id ?? null };
}
