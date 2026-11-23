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

/**
 * For functions only the scheduler should run. Supabase's gateway has already checked the
 * token (verify_jwt), and the scheduler sends the project's public key (D26). What we refuse
 * here is a signed-in person's own token: they have no business starting a queue run.
 * A project API key that is not a JWT has no person behind it, so it passes.
 */
export function carriesUser(req: Request): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return claims.role !== "anon" && claims.role !== "service_role";
  } catch {
    return true; // looks like a JWT but can't be read: not the scheduler's key
  }
}

export const notScheduler = () => json({ error: "Not allowed." }, 403);
