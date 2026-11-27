// The Bumpdraft name at the top of every page goes to the home page.
import { describe, expect, it } from "vitest";
import { html } from "hono/html";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { layout, messagePage, publicLayout } from "./views.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
const chain: Record<string, unknown> = {};
for (const m of ["select", "eq", "order", "limit", "ilike", "or", "range", "in", "not", "is", "gte", "lte"]) chain[m] = () => chain;
(chain as { then: unknown }).then = (r: (v: unknown) => void) => r({ data: [], error: null });
const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
  auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) },
  from: () => chain, rpc: async () => ({ data: [], error: null }),
}) as unknown as Supa });

/** Every link wrapped around the name in the page's top bar. */
const brandLinks = (page: string) => [...page.matchAll(/<a class="brand" href="([^"]*)">Bumpdraft<\/a>/g)].map((m) => m[1]);

describe("the Bumpdraft name links home", () => {
  it.each(["organizer", "public", "minimal"] as const)("in the %s header", async (audience) => {
    expect(brandLinks(String(await layout("T", html`<p>x</p>`, "", audience)))).toEqual(["/"]);
  });

  it("in the public layout and on message pages", async () => {
    expect(brandLinks(String(await publicLayout("T", html`<p>x</p>`)))).toEqual(["/"]);
    expect(brandLinks(String(await messagePage("Oops", "Something happened.")))).toEqual(["/"]);
  });

  it.each(["/", "/directory", "/login", "/terms", "/rules", "/takedown", "/privacy", "/contact", "/about/costs", "/help/unsubscribe", "/supporters", "/c/no-such-calendar", "/no-such-page",
    "/invite/stop/" + "ab".repeat(32)])("on %s", async (path) => {
    // A browser asks for HTML; the not-found and error pages answer other callers with JSON.
    const res = await app.request(`https://bumpdraft.test${path}`, { headers: { accept: "text/html" } }, env);
    const page = await res.text();
    const links = brandLinks(page);
    expect(links.length, `${path} (${res.status}) has one name link`).toBe(1);
    expect(links[0]).toBe("/");
  });
});
