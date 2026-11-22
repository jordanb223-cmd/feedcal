import { decodeBase64 } from "jsr:@std/encoding@1/base64";

// Phase 17 (D39): the Gmail API calls, pure apart from the injected fetch, so every rule is tested
// with a fake Google. Read-only scope. Two kinds of search only:
//   - the owner's own example search (their words, last 30 days, at most 10 results, metadata only)
//   - scheduled checks: "from:<the confirmed sender> after:<last check>", nothing else.
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Emails read per run. The first live check (2026-11-21) hit Supabase's per-run compute limit
// (WORKER_RESOURCE_LIMIT) trying 20 at once; a few per run, continuing 5 minutes later, fits.
export const MAX_PER_CHECK = 3;
const MAX_LISTED = 100;
export const EXAMPLE_RESULTS = 10;

export type Fetch = typeof fetch;

/** Google refused the refresh token (revoked, or the 7-day limit for unverified apps). */
export class ReconnectError extends Error {
  override name = "ReconnectError";
}

export interface Candidate { id: string; from_email: string; from_name: string; subject: string; date: string }

export async function accessToken(f: Fetch, clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (body.error === "invalid_grant") throw new ReconnectError("invalid_grant");
  if (!res.ok || !body.access_token) throw new Error(`token_${res.status}`);
  return body.access_token;
}

/** Exchanges the OAuth code (with the PKCE verifier) for tokens. */
export async function exchangeCode(f: Fetch, o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string }) {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, code: o.code, code_verifier: o.verifier,
      redirect_uri: o.redirectUri, grant_type: "authorization_code" }),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!res.ok || !body.access_token) throw new Error(`exchange_${res.status}`);
  return body;
}

async function get<T>(f: Fetch, token: string, path: string): Promise<{ status: number; body: T }> {
  const res = await f(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new ReconnectError("unauthorized");
  const body = await res.json().catch(() => ({})) as T;
  return { status: res.status, body };
}

/**
 * D51: revoke the token with Google, sending it in a form body (Google's docs show both a URL
 * parameter and a form body; the body keeps it out of URLs and request logs). True on 200.
 */
export async function revokeToken(f: Fetch, token: string): Promise<boolean> {
  const res = await f("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel();
  return res.ok;
}

export async function profileEmail(f: Fetch, token: string): Promise<string> {
  const r = await get<{ emailAddress?: string }>(f, token, "/profile");
  if (r.status !== 200) throw new Error(`profile_${r.status}`);
  return r.body.emailAddress ?? "";
}

async function listIds(f: Fetch, token: string, q: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let page: string | undefined;
  for (let i = 0; i < 5 && ids.length < max; i++) {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
    if (page) p.set("pageToken", page);
    const r = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(f, token, `/messages?${p}`);
    if (r.status !== 200) throw new Error(`list_${r.status}`);
    ids.push(...(r.body.messages ?? []).map((m) => m.id));
    page = r.body.nextPageToken;
    if (!page) break;
  }
  return ids.slice(0, max);
}

/** "Name <a@b.c>" or "a@b.c" → parts. Only a plain address counts. */
export function parseFrom(from: string): { email: string; name: string } | null {
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from) ?? /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(from);
  const email = m?.[1]?.toLowerCase() ?? "";
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/.test(email)) return null;
  const name = from.slice(0, m ? from.lastIndexOf(m[0]) : 0).replace(/^\s*"?|"?\s*$/g, "").slice(0, 200);
  return { email, name };
}

/** The owner's example search: their words, the last 30 days, sender/subject/date only. */
export async function searchExamples(f: Fetch, token: string, words: string): Promise<Candidate[]> {
  const q = `${words.replace(/[\r\n]/g, " ").slice(0, 100)} newer_than:30d -in:chats`;
  const ids = await listIds(f, token, q, EXAMPLE_RESULTS);
  const out: Candidate[] = [];
  for (const id of ids) {
    const p = new URLSearchParams({ format: "metadata" });
    for (const h of ["From", "Subject", "Date"]) p.append("metadataHeaders", h);
    const r = await get<{ id: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(f, token, `/messages/${encodeURIComponent(id)}?${p}`);
    if (r.status !== 200) continue;
    const h = (n: string) => r.body.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    const from = parseFrom(h("From"));
    const date = r.body.internalDate ? new Date(Number(r.body.internalDate)).toISOString() : "";
    if (!/^[A-Za-z0-9]{1,64}$/.test(id)) continue;
    out.push({ id, from_email: from?.email ?? "", from_name: from?.name ?? h("From").slice(0, 200), subject: h("Subject").slice(0, 300), date });
  }
  return out;
}

/** Scheduled check: only mail from the confirmed sender, after the last check. */
export function senderQuery(sender: string, after: Date): string {
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/.test(sender)) throw new Error("bad_sender");
  return `from:${sender} after:${Math.floor(after.getTime() / 1000)}`;
}

/** The message as the original raw email (RFC 822), exactly what a forward would carry. */
export async function rawMessage(f: Fetch, token: string, id: string): Promise<Uint8Array | null> {
  const r = await get<{ raw?: string }>(f, token, `/messages/${encodeURIComponent(id)}?format=raw`);
  if (r.status === 404) return null; // deleted since
  if (r.status !== 200 || !r.body.raw) throw new Error(`message_${r.status}`);
  const b64 = r.body.raw.replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export interface CheckDeps {
  fetch: Fetch;
  clientId: string;
  clientSecret: string;
  now(): Date;
  seen(ids: string[]): Promise<string[]>;
  /** Puts one raw email through the normal intake; returns the outcome and Feedcal's message id. */
  ingest(raw: Uint8Array): Promise<{ outcome: string; messageId: string | null }>;
  record(gmailId: string, outcome: string, messageId: string | null): Promise<void>;
}

/** One scheduled check: the example first (if not read yet), then new mail from the sender. */
export async function runCheck(c: { refreshToken: string; sender: string; exampleId: string | null; lastCheckedAt: Date }, d: CheckDeps) {
  const startedAt = d.now();
  const token = await accessToken(d.fetch, d.clientId, d.clientSecret, c.refreshToken);
  const found = await listIds(d.fetch, token, senderQuery(c.sender, c.lastCheckedAt), MAX_LISTED);
  const ids = [...new Set([...(c.exampleId ? [c.exampleId] : []), ...found])];
  const already = new Set(await d.seen(ids));
  const todo = ids.filter((id) => !already.has(id)).slice(0, MAX_PER_CHECK);
  let ingested = 0;
  for (const id of todo) {
    const raw = await rawMessage(d.fetch, token, id);
    if (!raw) { await d.record(id, "gone", null); continue; }
    const r = await d.ingest(raw);
    await d.record(id, r.outcome, r.messageId);
    ingested++;
  }
  // More waiting than one run takes: keep the old starting point (seen ones are skipped) and carry
  // on in 5 minutes rather than waiting for the next scheduled check.
  const more = ids.filter((id) => !already.has(id)).length > MAX_PER_CHECK;
  return { checkedAt: more ? c.lastCheckedAt : startedAt, ingested, more };
}
