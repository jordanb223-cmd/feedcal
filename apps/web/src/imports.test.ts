// D48: copying events from a calendar link, as a tucked-away option.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { importStatus } from "./imports.js";

const ID = "6dc8d67e-7490-4ffd-b718-4b4eed87274c";
const BASE = "https://feedcal.test";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", GMAIL_CLIENT_ID: "c" };

function app(result: unknown) {
  const calls: { fn: string; args: unknown }[] = [];
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { name: "Room F" }, error: null }) };
  const sb = {
    from: () => chain,
    rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return fn === "gmail_status" ? { data: { connected: false }, error: null } : { data: result, error: null }; },
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "o@example.test" } }, error: null }) },
  } as unknown as Supa;
  const a = createApp({ version: "1", commit: "c", supabase: () => sb, logSink: () => {} });
  async function post(path: string, fields: Record<string, string>) {
    const page = await a.request(`${BASE}/feeds/${ID}/setup`, {}, env);
    const cookie = /__Host-feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    return a.request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-feedcal_csrf=${cookie}`, origin: BASE } }, env);
  }
  return { a, post, calls };
}

describe("copy events from a calendar link (D48)", () => {
  it("is offered on the setup screen, but folded away from the main choices", async () => {
    const html = await (await app(null).a.request(`${BASE}/feeds/${ID}/setup`, {}, env)).text();
    const fold = html.indexOf("<summary>More ways to add events</summary>");
    expect(fold).toBeGreaterThan(html.indexOf("Connect Gmail"));
    expect(html.indexOf(`action="/feeds/${ID}/import"`)).toBeGreaterThan(fold);
    expect(html).toMatch(/name="keep" value="1">/); // not ticked: a one-time copy by default
    expect(html).not.toMatch(/name="keep" value="1" checked/);
  });

  it("a one-time copy by default; ticking the box keeps it updating", async () => {
    const t = app("ok");
    const res = await t.post(`/feeds/${ID}/import`, { url: "webcal://cal.example.org/a.ics", back: "setup" });
    expect(res.headers.get("location")).toBe(`/feeds/${ID}/settings?import=started`);
    expect(t.calls.find((c) => c.fn === "feed_import_set")?.args).toEqual({ p_feed_id: ID, p_url: "webcal://cal.example.org/a.ics", p_keep_updating: false });
    await t.post(`/feeds/${ID}/import`, { url: "https://cal.example.org/a.ics", keep: "1" });
    expect(t.calls.filter((c) => c.fn === "feed_import_set")[1]?.args).toMatchObject({ p_keep_updating: true });
  });

  it("a link that won't work gets a plain explanation", async () => {
    const res = await app("bad_url").post(`/feeds/${ID}/import`, { url: "http://x" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("starts with https://");
  });

  it("settings show what's set up and how to stop it", async () => {
    const html = String(await importStatus(ID, "t", { url: "https://cal.example.org/a.ics", mode: "daily", imported_at: "2026-11-21T00:00:00Z", events: 12 }));
    expect(html).toContain("Checking every day:");
    expect(html).toContain("12 events so far.");
    expect(html).toContain(`action="/feeds/${ID}/import/stop"`);
    expect(html).toContain("Stopping keeps the events already copied.");
  });
});
