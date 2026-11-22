import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import { jsonLd } from "./subscribe-views.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };
const row = { slug: "lp-soccer", name: "Land Park Soccer", description: "Youth soccer", category: "youth sports", city: "Sacramento", state: "CA",
  distance_miles: 1.2, subscribers: 14, last_updated_at: "2026-11-20T00:00:00Z", may_be_out_of_date: false, verified: true, imported_source_name: null };

function setup(rows: unknown[] = [row]) {
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  const from = vi.fn(() => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ slug: "lp-soccer", last_updated_at: "2026-11-20T00:00:00Z" }] }) }), maybeSingle: async () => ({ data: null }) }) }) }));
  const userClient = vi.fn(() => { throw new Error("the directory must not use the user's session"); });
  const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: userClient as never, anonSupabase: () => ({ rpc, from }) as unknown as Supa });
  return { rpc, request: (p: string) => app.request(`https://feedcal.example${p}`, {}, env) };
}

describe("directory (anonymous, public feeds only)", () => {
  it("searches with the anon client and lists ranked results", async () => {
    const { request, rpc } = setup();
    const res = await request("/directory?q=Land+Park+soccer&zip=95818&miles=5&category=youth+sports");
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("directory_search", { p_query: "Land Park soccer", p_zip: "95818", p_miles: 5, p_category: "youth sports", p_limit: 30 });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.text();
    expect(body).toContain('<a href="/c/lp-soccer"><strong dir="auto">Land Park Soccer</strong></a>');
    expect(body).toContain("1.2 mi");
    expect(body).not.toContain("following") /* D49: never shown publicly */;
  });
  it("/near/<zip> searches by ZIP; bad input falls back safely", async () => {
    const { request, rpc } = setup([]);
    await request("/near/95818");
    expect(rpc).toHaveBeenCalledWith("directory_search", { p_zip: "95818", p_miles: 10, p_limit: 30 });
    expect((await request("/near/abc")).status).toBe(302);
    const odd = await request("/directory?miles=999&category=hacking");
    expect(odd.status).toBe(200);
  });
  it("sitemap lists public feeds; robots keeps calendar files and accounts out", async () => {
    const { request } = setup();
    const xml = await (await request("/sitemap.xml")).text();
    expect(xml).toContain("<loc>https://feedcal.example/c/lp-soccer</loc>");
    const robots = await (await request("/robots.txt")).text();
    expect(robots).toContain("Disallow: /f/");
    expect(robots).toContain("Sitemap: https://feedcal.example/sitemap.xml");
  });
  it("schema.org JSON-LD can't be broken out of by event text", () => {
    const out = jsonLd("Feed", "https://x/c/f", [{ id: "e", uid: "u", title: "</script><script>alert(1)</script>", description: null, location: "Gym", starts_at: "2026-12-01T18:00:00Z", ends_at: null, all_day: false, timezone: "America/Los_Angeles", rrule: null, status: "confirmed" }]);
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).itemListElement[0].item).toMatchObject({ "@type": "Event", startDate: "2026-12-01T18:00:00Z", eventStatus: "https://schema.org/EventScheduled" });
  });
});
