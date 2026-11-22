// Intake helpers shared by ingest-start and ingest-commit. Pure functions, no I/O, Deno-tested.
// This reads only the email's headers (and, for Gmail's confirmation, its text). Real MIME
// parsing is Phase 7.

const enc = new TextEncoder();

// ---------------------------------------------------------------- request signing
// The Email Worker signs `${timestamp}.${body}` with HMAC-SHA256. Requests older or newer than
// five minutes are refused, so a captured request can't be replayed later.
export const MAX_SKEW_SECONDS = 300;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sign(secret: string, timestamp: string, body: string): Promise<string> {
  return hmacHex(secret, `${timestamp}.${body}`);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignature(
  secret: string | undefined,
  timestamp: string | null,
  signature: string | null,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || secret.length < 32 || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  return safeEqual(await sign(secret, timestamp, body), signature);
}

// ---------------------------------------------------------------- headers
/** Splits raw MIME at the first blank line. Bytes stay bytes; headers are read as Latin-1 (1:1). */
export function splitMessage(raw: Uint8Array): { headerText: string; body: Uint8Array } {
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) return { headerText: latin1(raw.subarray(0, i)), body: raw.subarray(i + 2) };
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a) {
      return { headerText: latin1(raw.subarray(0, i)), body: raw.subarray(i + 4) };
    }
  }
  return { headerText: latin1(raw), body: new Uint8Array() };
}

export function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

/** Unfolded headers in order. Names lower-cased. */
export function readHeaders(headerText: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of headerText.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  return out;
}

export function firstHeader(headers: [string, string][], name: string): string | null {
  return headers.find(([n]) => n === name)?.[1] ?? null;
}

/** The address inside "Name <a@b>", or a bare address. Lower-cased. Null if none. */
/** D60: linear time on a capped header (the old regexes were quadratic on long "From:" lines). */
const MAX_FROM_HEADER = 2000;
export function extractAddress(value: string | null): string | null {
  if (!value) return null;
  const line = value.slice(0, MAX_FROM_HEADER);
  let addr = "";
  for (let lt = line.indexOf("<"); lt >= 0 && !addr; lt = line.indexOf("<", lt + 1)) {
    const gt = line.indexOf(">", lt + 1);
    if (gt < 0) break;
    const inside = line.slice(lt + 1, gt);
    const at = inside.indexOf("@");
    if (at > 0 && at < inside.length - 1 && !/[<>\s]/.test(inside)) addr = inside;
  }
  if (!addr) addr = line.split(/[\s<>",;:]+/).find((t) => { const at = t.indexOf("@"); return at > 0 && at < t.length - 1; }) ?? "";
  addr = addr.toLowerCase();
  return addr.length > 0 && addr.length <= 320 ? addr : null;
}

/** RFC 2047 encoded words (B and Q), UTF-8 or Latin-1. Anything else is left as is. */
export function decodeWords(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (whole, charset: string, kind: string, text: string) => {
      try {
        let bytes: Uint8Array;
        if (kind.toLowerCase() === "b") {
          bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        } else {
          const s = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
          bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
        }
        return new TextDecoder(charset.toLowerCase() === "utf-8" ? "utf-8" : "latin1", { fatal: false }).decode(bytes);
      } catch {
        return whole;
      }
    });
}

// ---------------------------------------------------------------- authentication results
export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/**
 * Cloudflare Email Routing prepends one Authentication-Results header with the authserv-id
 * mx.cloudflare.net. Only the FIRST such header is trusted; any others could come from the
 * sender (Cloudflare Workers API docs, "Authentication results").
 */
export function authResults(headers: [string, string][]): AuthResults {
  const first = firstHeader(headers, "authentication-results");
  const none: AuthResults = { spf: null, dkim: null, dmarc: null };
  if (!first || !/^mx\.cloudflare\.net\s*;/i.test(first)) return none;
  const pick = (method: string) => new RegExp(`\\b${method}=([a-z]+)`, "i").exec(first)?.[1]?.toLowerCase() ?? null;
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") };
}

// ---------------------------------------------------------------- limits
/** Approximate attachment count without a MIME parser: parts declared as attachments. */
export function countAttachments(rawText: string): number {
  return (rawText.match(/^content-disposition:[ \t]*attachment\b/gim) ?? []).length;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** Postgres bytea hex input. */
export function byteaHex(bytes: Uint8Array): string {
  return "\\x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- Gmail forwarding confirmation
// Sender and subject format are community-documented (D26), not in Google's own help pages.
export const GMAIL_FORWARDING_SENDER = "forwarding-noreply@google.com";
const ALLOWED_CONFIRM_HOSTS = new Set(["mail-settings.google.com", "mail.google.com"]);

export interface GmailConfirmation {
  code: string;
  url: string | null;
  requested_by: string | null;
}

/** Undo quoted-printable soft breaks and escapes, enough to find a URL. */
function unQuotedPrintable(text: string): string {
  return text.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Only for mail from Google's forwarding sender that passed DMARC at Cloudflare, so a forged
 * "confirmation" can't put a phishing link on the owner's screen. The link must be on Google.
 */
export function gmailConfirmation(
  sender: string | null,
  subject: string | null,
  dmarc: string | null,
  bodyText: string,
): GmailConfirmation | null {
  if (sender !== GMAIL_FORWARDING_SENDER || dmarc !== "pass" || !subject) return null;
  const code = /\(#(\d{6,12})\)/.exec(subject)?.[1];
  if (!code || !/forwarding confirmation/i.test(subject)) return null;
  const requested = /receive (?:mail|emails?) from\s+(\S+@\S+)/i.exec(subject)?.[1] ?? null;
  let url: string | null = null;
  for (const m of unQuotedPrintable(bodyText).matchAll(/https:\/\/[^\s"'<>()]+/g)) {
    try {
      const u = new URL(m[0]);
      if (ALLOWED_CONFIRM_HOSTS.has(u.hostname) && m[0].length <= 2000) {
        url = u.toString();
        break;
      }
    } catch {
      // not a URL
    }
  }
  return { code, url, requested_by: requested ? requested.slice(0, 320).toLowerCase() : null };
}

// ---------------------------------------------------------------- everything commit needs
export interface CommitFacts extends AuthResults {
  messageId: string | null;
  sender: string | null;
  subject: string | null;
  bodySha256: Uint8Array;
  attachmentCount: number;
  gmail: GmailConfirmation | null;
}

export async function commitFacts(raw: Uint8Array): Promise<CommitFacts> {
  const { headerText, body } = splitMessage(raw);
  const headers = readHeaders(headerText);
  const auth = authResults(headers);
  const sender = extractAddress(firstHeader(headers, "from"));
  const subject = decodeWords(firstHeader(headers, "subject"))?.slice(0, 998) ?? null;
  const messageId = firstHeader(headers, "message-id")?.slice(0, 998) ?? null;
  const rawText = latin1(raw);
  return {
    ...auth,
    messageId,
    sender,
    subject,
    bodySha256: await sha256(body),
    attachmentCount: countAttachments(rawText),
    gmail: gmailConfirmation(sender, subject, auth.dmarc, latin1(body)),
  };
}
