import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./types.js";

/** True when the request arrived over HTTPS. Local `wrangler pages dev` is plain HTTP. */
export function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export function originOf(c: Context): string {
  return new URL(c.req.url).origin;
}

/**
 * Only same-site relative paths are allowed as a post-sign-in destination, so a link
 * can't bounce a user to another site (open redirect). Anything else goes to /account.
 */
export function safeNext(next: string | undefined | null, fallback = "/account"): string {
  if (!next || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback; // control characters
  }
  return next;
}

/** Paths that contain a secret (feed tokens) are logged with the secret removed. */
export function redactPath(path: string): string {
  return path.replace(/^\/f\/[^/]*$/, "/f/[token]");
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Rejects state-changing requests whose Origin (or, if absent, Referer) isn't this site.
 * Browsers send Origin on cross-site form posts, so a forged form from another site fails here.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!UNSAFE.has(c.req.method)) return next();
  // RFC 8058 one-click unsubscribe: mail apps POST from their servers with no Origin. The signed
  // token in the URL authorises it, and it can only turn emails off (D33).
  if (c.req.method === "POST" && new URL(c.req.url).pathname === "/unsubscribe") return next();
  const expected = originOf(c);
  const origin = c.req.header("origin");
  let actual: string | null = origin && origin !== "null" ? origin : null;
  if (!actual) {
    const referer = c.req.header("referer");
    try {
      actual = referer ? new URL(referer).origin : null;
    } catch {
      actual = null;
    }
  }
  if (actual !== expected) {
    c.get("log").warn("origin_rejected", { path: new URL(c.req.url).pathname });
    return c.text("This request came from another site, so it was blocked.", 403);
  }
  return next();
};

// ---------------------------------------------------------------- CSRF (double-submit cookie)

function csrfCookieName(c: Context): string {
  // __Host- requires Secure, so it's only usable over HTTPS.
  return isSecure(c) ? "__Host-feedcal_csrf" : "feedcal_csrf";
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns the CSRF token for forms on this page, setting the cookie if it isn't there yet. */
export function csrfToken(c: Context): string {
  const name = csrfCookieName(c);
  const existing = getCookie(c, name);
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const token = randomToken();
  setCookie(c, name, token, { path: "/", httpOnly: true, secure: isSecure(c), sameSite: "Lax", maxAge: 60 * 60 * 24 });
  return token;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the form's token matches the cookie. */
export function csrfValid(c: Context, formToken: unknown): boolean {
  const cookie = getCookie(c, csrfCookieName(c));
  return typeof formToken === "string" && typeof cookie === "string" && cookie.length === 43 && timingSafeEqual(cookie, formToken);
}
