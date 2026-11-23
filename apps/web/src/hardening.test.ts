// Phase 16 (D37): headers, assets, no inline scripts, session-only cookies, rate limits.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { APP_JS, ASSET_PATHS } from "./assets.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
const TOKEN = "A".repeat(20) + "b_-" + "C".repeat(20);

function app(rpc: (fn: string) => { data: unknown; error: unknown } = () => ({ data: null, error: null })) {
  const sb = { rpc: async (fn: string) => rpc(fn), auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) } } as unknown as Supa;
  const a = createApp({ version: "1", commit: "c", supabase: () => sb, anonSupabase: () => sb, logSink: () => {} });
  return (url: string, init: RequestInit = {}) => a.request(url, init, env);
}

describe("security headers", () => {
  it("a strict CSP on every page: scripts only from this origin, no framing", async () => {
    const res = await app()("https://feedcal.test/login");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self' https://ref.supabase.co https://accounts.google.com");
    // Attachment thumbnails and review images are signed links on the storage origin.
    expect(csp).toContain("img-src 'self' data: https://ref.supabase.co;");
    // The one web font is served from this site's own /fonts (DESIGN.md); nothing loads from elsewhere.
    expect(csp).toContain("font-src 'self'");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("the same headers on a calendar feed and on an error page", async () => {
    const feed = await app((fn) => fn === "feed_calendar_guarded"
      ? { data: { feed: { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "R", slug: "r", description: null, visibility: "private", last_updated_at: "2026-11-02T12:00:00Z" }, events: [] }, error: null }
      : { data: null, error: null })(`https://feedcal.test/f/${TOKEN}.ics`);
    const missing = await app()("https://feedcal.test/no-such-page");
    expect(missing.status).toBe(404);
    for (const res of [feed, missing]) {
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
    }
  });

  it("HSTS max-age can be raised to a year by configuration", async () => {
    const sb = { rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) } } as unknown as Supa;
    const a = createApp({ version: "1", commit: "c", supabase: () => sb, logSink: () => {} });
    const res = await a.request("https://feedcal.test/login", {}, { ...env, HSTS_MAX_AGE: "31536000" });
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("no HSTS over plain HTTP (local development)", async () => {
    expect((await app()("http://localhost:8788/login")).headers.get("strict-transport-security")).toBeNull();
  });

  it("a route's stricter referrer policy is kept (calendar feeds send no referrer)", async () => {
    const res = await app(() => ({ data: null, error: null }))(`https://feedcal.test/f/${TOKEN}.ics`);
    expect(res.status).toBe(404);
    const ok = await app((fn) => fn === "feed_calendar_guarded"
      ? { data: { feed: { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "R", slug: "r", description: null, visibility: "private", last_updated_at: "2026-11-02T12:00:00Z" }, events: [] }, error: null }
      : { data: null, error: null })(`https://feedcal.test/f/${TOKEN}.ics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("assets", () => {
  it("the stylesheet and script are served from this origin, cached for a year", async () => {
    for (const path of [ASSET_PATHS.css, ASSET_PATHS.js]) {
      const res = await app()(`https://feedcal.test${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const page = await (await app()("https://feedcal.test/login")).text();
    expect(page).toContain(`<script src="${ASSET_PATHS.js}" defer></script>`);
    expect(page).toContain(`<link rel="stylesheet" href="${ASSET_PATHS.css}">`);
    expect(APP_JS).toContain("data-countdown");
  });

});

describe("PWA (D38)", () => {
  it("serves a manifest and an icon from this origin, with no cookie, and the CSP allows them", async () => {
    const m = await app()("https://feedcal.test/manifest.webmanifest");
    expect(m.headers.get("content-type")).toBe("application/manifest+json");
    expect(m.headers.get("set-cookie")).toBeNull();
    const manifest = JSON.parse(await m.text()) as { name: string; display: string; icons: { src: string }[] };
    expect(manifest.name).toBe("Calantern");
    expect(manifest.display).toBe("standalone");
    const icon = await app()(`https://feedcal.test${manifest.icons[0]?.src ?? ""}`);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    const page = await app()("https://feedcal.test/login");
    expect(await page.text()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(page.headers.get("content-security-policy")).toContain("manifest-src 'self'");
  });
});

describe("cookies", () => {
  it("the CSRF cookie is session-only (no Max-Age or Expires)", async () => {
    const res = await app()("https://feedcal.test/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-feedcal_csrf=");
    expect(cookie).not.toMatch(/max-age|expires/i);
  });
});

describe("rate limits", () => {
  it("an address that keeps missing calendar tokens gets 429 with Retry-After", async () => {
    const res = await app(() => ({ data: null, error: { code: "P0429", message: "x" } }))(`https://feedcal.test/f/${TOKEN}.ics`, { headers: { "cf-connecting-ip": "198.51.100.7" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
  });

  it("directory search over the limit gets 429", async () => {
    const res = await app((fn) => (fn === "rate_check" ? { data: false, error: null } : { data: [], error: null }))("https://feedcal.test/directory?q=soccer", { headers: { "cf-connecting-ip": "198.51.100.7" } });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Slow down");
  });

  it("subscribe taps over the limit aren't counted, but the hand-off still works", async () => {
    const calls: string[] = [];
    const go = app((fn) => {
      calls.push(fn);
      if (fn === "rate_check") return { data: false, error: null };
      if (fn === "public_feed_page") return { data: { feed: { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "R", slug: "r", description: null, category: "school", zip_code: null, area: null,
        visibility: "public", last_updated_at: "2026-11-02T12:00:00Z", organizer_name: null, subscribers_at_least: 0, feed_token: TOKEN }, events: [] }, error: null };
      return { data: null, error: null };
    });
    const res = await go("https://feedcal.test/c/r/go/google", { headers: { "cf-connecting-ip": "198.51.100.7" } });
    expect(res.status).toBe(302);
    expect(calls).not.toContain("record_subscribe_click");
  });
});

describe("privacy pages", () => {
  it("the privacy page is public and sets no cookie", async () => {
    const res = await app()("https://feedcal.test/privacy");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("How long we keep it");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("export needs sign-in", async () => {
    const res = await app()("https://feedcal.test/account/export");
    expect(res.status).toBe(303);
  });
});

// D51: the web server proves itself to the database so visitor addresses can be trusted.
describe("server-only proof for database calls (D51)", () => {
  it("is sent only when configured, and never appears in a page", async () => {
    const { proxyHeaders } = await import("./supabase.js");
    const ctx = (env: Record<string, string>) => ({ env }) as unknown as Parameters<typeof proxyHeaders>[0];
    expect(proxyHeaders(ctx({ RPC_PROXY_KEY: "k-123" }))).toEqual({ "x-feedcal-proxy": "k-123" });
    expect(proxyHeaders(ctx({}))).toEqual({});
  });
});
