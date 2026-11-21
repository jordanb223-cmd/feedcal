// Small HTTP helpers for Edge Functions. Logs carry ids and counts, never addresses or content.
import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { verifySignature } from "./intake.ts";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function log(service: string, requestId: string, msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, service, request_id: requestId, ...fields }));
}

export function admin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Reads the body and checks the Email Worker's HMAC signature. Null means refuse. */
export async function signedBody(req: Request): Promise<string | null> {
  if (req.method !== "POST") return null;
  const body = await req.text();
  if (body.length > 10_000) return null;
  const ok = await verifySignature(
    Deno.env.get("INGEST_HMAC_SECRET"),
    req.headers.get("x-feedcal-timestamp"),
    req.headers.get("x-feedcal-signature"),
    body,
  );
  return ok ? body : null;
}
