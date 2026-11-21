import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { bmcUrl } from "./support.js";

const BASE = "http://localhost:8788";
const anon = {
  rpc: async () => ({ data: [{ display_name: "Jamie <b>", since: "2026-11-01" }], error: null }),
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
} as unknown as Supa;
const app = createApp({ version: "t", commit: "t", supabase: () => anon, anonSupabase: () => anon, logSink: () => {} });
const env = (extra: Partial<Bindings> = {}): Bindings => ({ ENVIRONMENT: "local", SUPABASE_URL: "http://x", SUPABASE_ANON_KEY: "k", ...extra });

describe("support pages (D36)", () => {
  it("builds the Buy Me a Coffee link only from a valid page name", () => {
    expect(bmcUrl("feedcal")).toBe("https://buymeacoffee.com/feedcal");
    expect(bmcUrl(undefined)).toBeNull();
    expect(bmcUrl("evil.example/x")).toBeNull();
    expect(bmcUrl('a"onmouseover=1')).toBeNull();
  });

  it("the costs page shows the link only when configured, with no third-party script", async () => {
    const off = await (await app.request(`${BASE}/about/costs`, {}, env())).text();
    expect(off).toContain("Donations aren't set up yet");
    const res = await app.request(`${BASE}/about/costs`, {}, env({ BMC_USERNAME: "feedcal" }));
    const on = await res.text();
    expect(on).toContain('href="https://buymeacoffee.com/feedcal"');
    expect(on).not.toMatch(/<script[^>]+src="(?!\/assets\/)/);  // only our own script
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the supporters page escapes names and sets no cookie", async () => {
    const res = await app.request(`${BASE}/supporters`, {}, env());
    const body = await res.text();
    expect(body).toContain("Jamie &lt;b&gt;");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the account support page needs sign-in", async () => {
    const res = await app.request(`${BASE}/account/support`, {}, env());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=/account/support");
  });
});
