// Edge Function: uploading a file to a calendar (D61). Called by the web app with the organizer's
// own session. "start" checks membership, type, size and the daily limit, then returns a one-time
// link to a server-chosen spot in private storage; the browser sends the file there directly.
// "finish" checks the stored file itself (size, and that its bytes really are the claimed type),
// then records it, which queues it for reading exactly like an email attachment.
import { z } from "npm:zod@4.6.7";
import { admin, json, log } from "../_shared/http.ts";
import { bytesMatchType } from "../_shared/triage/docx.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), feed_id: z.uuid(), filename: z.string().min(1).max(255), mime: z.string().max(120), bytes: z.number().int().min(1) }),
  z.object({ action: z.literal("finish"), ticket: z.uuid() }),
]);
const MESSAGES: Record<string, string> = {
  not_allowed: "You can't add files to that calendar.", unsupported_type: "That kind of file can't be read. Use a PDF, Word (.docx), photo or text file.",
  too_large: "That file is over 10 MB. Try a smaller copy, or just the pages with dates.", empty: "That file is empty.", bad_name: "That file name can't be used.",
  daily_limit: "You've uploaded 20 files today. Try again tomorrow.", expired: "That upload took too long. Please try again.", already_used: "That file was already added.",
  unknown_ticket: "Please try the upload again.", not_uploaded: "The file didn't arrive. Please try again.", type_mismatch: "That file isn't what its name says it is.",
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const db = admin();
  const { data: who } = await db.auth.getUser(jwt);
  const user = who?.user;
  if (!user) return json({ error: "Please sign in again." }, 401);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Please try the upload again." }, 400);
  const fail = (reason: string, status = 400) => {
    log("upload-file", requestId, "upload_refused", { reason });
    return json({ error: MESSAGES[reason] ?? "Please try again.", reason }, status);
  };

  if (parsed.data.action === "start") {
    const { feed_id, filename, mime, bytes } = parsed.data;
    const { data, error } = await db.rpc("upload_start", { p_user: user.id, p_feed: feed_id, p_filename: filename, p_mime: mime, p_bytes: bytes });
    if (error) return json({ error: "Please try again in a minute." }, 503);
    const r = data as { ok: boolean; reason?: string; ticket?: string; path?: string };
    if (!r.ok || !r.path) return fail(r.reason ?? "unknown_ticket", r.reason === "not_allowed" ? 403 : 400);
    const { data: signed, error: signError } = await db.storage.from("attachments").createSignedUploadUrl(r.path);
    if (signError || !signed) return json({ error: "Please try again in a minute." }, 503);
    log("upload-file", requestId, "upload_started", { feed_id, bytes });  // never the file name
    return json({ ticket: r.ticket, url: signed.signedUrl });
  }

  const { ticket } = parsed.data;
  const { data: info } = await db.rpc("upload_ticket", { p_user: user.id, p_ticket: ticket });
  const t = info as { path: string; mime: string; feed: string; usable: boolean } | null;
  if (!t) return fail("unknown_ticket");
  if (!t.usable) return fail("expired");
  const { data: blob, error: dlError } = await db.storage.from("attachments").download(t.path);
  if (dlError || !blob) return fail("not_uploaded");
  const remove = () => db.storage.from("attachments").remove([t.path]);
  if (blob.size < 1 || blob.size > MAX_BYTES) { await remove(); return fail(blob.size < 1 ? "empty" : "too_large"); }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytesMatchType(t.mime, bytes)) { await remove(); return fail("type_mismatch"); }
  const { data, error } = await db.rpc("upload_finish", { p_user: user.id, p_ticket: ticket, p_bytes: bytes.length, p_sha256: await sha256Hex(bytes) });
  const r = data as { ok: boolean; reason?: string; message?: string; feed?: string } | null;
  if (error || !r?.ok) { await remove(); return fail(r?.reason ?? "unknown_ticket"); }
  log("upload-file", requestId, "upload_finished", { feed_id: r.feed, bytes: bytes.length });
  return json({ ok: true, message: r.message, feed: r.feed });
});
