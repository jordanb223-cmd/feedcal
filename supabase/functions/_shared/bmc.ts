// Buy Me a Coffee webhooks (D36). Per BMC's help centre (checked 2026-11-21): every request has an
// `x-signature-sha256` header, an HMAC-SHA256 of the raw body keyed with the webhook's signing
// secret; the outer payload is {event_id, type, live_mode, created, attempt, data}. The article
// doesn't say whether the signature is hex or base64, so both are accepted (constant-time compare).
// The field names inside `data` aren't documented there; they're read defensively (UNVERIFIED).
import { z } from "npm:zod@4.6.7";

const enc = new TextEncoder();

export async function signatureValid(secret: string | undefined, rawBody: string, header: string | null): Promise<boolean> {
  if (!secret || secret.length < 8 || !header) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = btoa(String.fromCharCode(...mac));
  const given = header.trim().replace(/^sha256=/i, "");
  return safeEqual(given.toLowerCase(), hex) || safeEqual(given, b64);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const BmcEvent = z.object({
  event_id: z.union([z.number().int(), z.string().regex(/^\d{1,18}$/).transform(Number)]),
  type: z.string().min(1).max(60),
  live_mode: z.boolean(),
  created: z.number().optional(),
  attempt: z.number().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type BmcEvent = z.infer<typeof BmcEvent>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Pulls the supporter and amount from `data`, trying the likely field names. */
export function supporterOf(data: Record<string, unknown>): { email: string | null; name: string | null; amountCents: number | null; currency: string | null } {
  const supporter = (data.supporter && typeof data.supporter === "object" ? data.supporter : {}) as Record<string, unknown>;
  const email = str(data.supporter_email) ?? str(data.payer_email) ?? str(data.email) ?? str(supporter.email);
  const name = str(data.supporter_name) ?? str(data.payer_name) ?? str(data.name) ?? str(supporter.name);
  const rawAmount = data.amount ?? data.total_amount ?? data.support_coffee_price;
  const amount = typeof rawAmount === "number" ? rawAmount : typeof rawAmount === "string" ? Number(rawAmount) : NaN;
  const currency = str(data.currency) ?? str(data.support_currency);
  return {
    email: email && email.includes("@") ? email.slice(0, 320) : null,
    name: name ? name.slice(0, 80) : null,
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
  };
}
