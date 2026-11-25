// D60: public pages tell search engines and link previews what they are.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
const rows = { data: [], error: null };
const chain: Record<string, unknown> = {};
for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
(chain as { then: unknown }).then = (r: (v: unknown) => void) => r(rows);
const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
  auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) },
  from: () => chain, rpc: async () => ({ data: [], error: null }),
}) as unknown as Supa });

describe("search and link previews (D60)", () => {
  it.each(["/", "/privacy", "/terms", "/rules", "/takedown", "/about/costs", "/help/unsubscribe"])("%s has a description, canonical link and preview tags", async (path) => {
    const html = await (await app.request(`https://bumpdraft.test${path}`, {}, env)).text();
    expect(html).toMatch(/<meta name="description" content="[^"]{40,}">/);
    expect(html).toContain(`<link rel="canonical" href="https://bumpdraft.test${path}">`);
    for (const p of ["og:type", "og:site_name", "og:title", "og:description", "og:url"]) expect(html).toContain(`property="${p}"`);
    expect((html.match(/<meta name="description"/g) ?? []).length).toBe(1);
  });
});
