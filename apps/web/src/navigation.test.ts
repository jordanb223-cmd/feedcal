// No dead ends (2026-11-21): every HTML page the site serves has the site header. Public pages
// show no organizer links; organizer pages link to Your feeds and Account.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", BMC_USERNAME: "someone" };

function app(signedIn: boolean) {
  const empty = { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "order", "limit", "in", "gte", "is", "neq"]) chain[k] = () => chain;
  chain.maybeSingle = async () => empty;
  chain.single = async () => empty;
  chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
  const sb = {
    rpc: async () => empty,
    from: () => chain,
    auth: {
      getUser: async () => (signedIn ? { data: { user: { id: "u1", email: "o@example.test" } }, error: null } : { data: { user: null }, error: { message: "x" } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }), listFactors: async () => ({ data: { totp: [] }, error: null }) },
    },
  } as unknown as Supa;
  const a = createApp({ version: "1", commit: "c", supabase: () => sb, anonSupabase: () => sb, logSink: () => {} });
  return (path: string) => a.request(`https://feedcal.test${path}`, { headers: { accept: "text/html" } }, env);
}

const PUBLIC = ["/login", "/directory", "/rules", "/terms", "/takedown", "/privacy", "/about/costs", "/supporters", "/c/no-such-calendar", "/c/no-such-calendar/report", "/no-such-page"];
const ORGANIZER = ["/account", "/feeds", "/feeds/new", "/account/support", "/feeds/6dc8d67e-7490-4ffd-b718-4b4eed87274c/share"];

describe("every page has a way to move on", () => {
  it("public pages: a header, and no organizer links", async () => {
    const get = app(false);
    for (const path of PUBLIC) {
      const res = await get(path);
      const html = await res.text();
      expect(html, path).toContain('aria-label="Site"');
      expect(html, path).toContain('<a class="skip" href="#main">Skip to content</a>');
      expect(html, path).toContain('<meta name="theme-color" content="#f6f6f4">');
      if (res.status === 200) expect(html, path).not.toContain('href="/feeds">Your feeds');
    }
  });

  it("organizer pages (signed in): a header with Your feeds and Account", async () => {
    const get = app(true);
    for (const path of ORGANIZER) {
      const res = await get(path);
      if (res.status >= 300 && res.status < 400) continue; // a redirect is a way on too
      const html = await res.text();
      expect(html, path).toContain('aria-label="Site"');
      if (res.status === 200) {
        expect(html, path).toContain('<a href="/feeds">Your feeds</a>');
        expect(html, path).toContain('<a href="/account">Account</a>');
      }
    }
  });
});
