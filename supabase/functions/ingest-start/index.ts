// Edge Function: the Email Worker asks to deliver one message. Checks the address, size and
// daily cap (in SQL), then returns a one-time upload token for the private inbound-raw bucket.
// Called only by the Email Worker, authenticated by HMAC (no JWT; config.toml verify_jwt = false).
import { z } from "npm:zod@4.6.7";
import { admin, json, log, signedBody } from "../_shared/http.ts";

const Body = z.object({ to: z.string().min(3).max(320), bytes: z.number().int().min(0).max(1_000_000_000) });

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const raw = await signedBody(req);
  if (raw === null) return json({ error: "Not allowed." }, 403);
  const parsed = Body.safeParse(JSON.parse(raw));
  if (!parsed.success) return json({ error: "Bad request." }, 400);
  const localPart = parsed.data.to.split("@")[0] ?? "";
  const domain = Deno.env.get("INTAKE_DOMAIN");
  if (domain && parsed.data.to.split("@")[1]?.toLowerCase() !== domain.toLowerCase()) {
    log("ingest-start", requestId, "ingest_rejected", { reject: "unknown_address" });
    return json({ ok: false, reject: "unknown_address" });
  }

  const db = admin();
  const { data, error } = await db.rpc("ingest_start", { p_local_part: localPart, p_bytes: parsed.data.bytes });
  if (error) {
    log("ingest-start", requestId, "ingest_start_failed", { code: error.code });
    return json({ error: "Try again later." }, 503);
  }
  const start = data as { ok: boolean; reject?: string; ticket?: string; path?: string };
  if (!start.ok || !start.path) {
    log("ingest-start", requestId, "ingest_rejected", { reject: start.reject ?? "unknown" });
    return json({ ok: false, reject: start.reject ?? "unknown" });
  }
  const signed = await db.storage.from("inbound-raw").createSignedUploadUrl(start.path);
  if (signed.error) {
    log("ingest-start", requestId, "signed_upload_failed");
    return json({ error: "Try again later." }, 503);
  }
  log("ingest-start", requestId, "ingest_started", { ticket: start.ticket, bytes: parsed.data.bytes });
  // The Worker builds the upload URL from its own Supabase URL, so this works locally too.
  return json({ ok: true, ticket: start.ticket, path: start.path, token: signed.data.token });
});
