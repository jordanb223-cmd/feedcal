// Phase 17 (D39) web flow: connect → search → pick → confirm (what Feedcal will do) → status.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const ID = "6dc8d67e-7490-4ffd-b718-4b4eed87274c";
const BASE = "https://feedcal.test";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", GMAIL_CLIENT_ID: "client-123.apps.googleusercontent.com" };
const CANDS = [{ id: "abc123", from_email: "office@school.example", from_name: "Room F", subject: "November schedule", date: "2026-11-14T16:00:00Z" }];

function app(status: unknown, opts: { owner?: boolean; invoke?: unknown } = {}) {
  const calls: { fn: string; args: unknown }[] = [];
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { name: "Room F" }, error: null }) };
  const sb = {
    from: () => chain,
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (opts.owner === false) return { data: null, error: { code: "42501" } };
      if (fn === "gmail_status") return { data: status, error: null };
      if (fn === "gmail_start") return { data: { state: "s".repeat(64), code_challenge: "c".repeat(43) }, error: null };
      if (fn === "gmail_choose_example" || fn === "gmail_look_back") return { data: true, error: null };
      return { data: null, error: null };
    },
    functions: { invoke: async (name: string, o: unknown) => { calls.push({ fn: `invoke:${name}`, args: o }); return { data: opts.invoke ?? { candidates: CANDS }, error: null }; } },
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "o@example.test" } }, error: null }) },
  } as unknown as Supa;
  const a = createApp({ version: "1", commit: "c", supabase: () => sb, logSink: () => {} });
  const get = (p: string) => a.request(`${BASE}${p}`, {}, env);
  async function post(p: string, fields: Record<string, string>) {
    const page = await get(`/feeds/${ID}/gmail`);
    const cookie = /__Host-feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    return a.request(`${BASE}${p}`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-feedcal_csrf=${cookie}`, origin: BASE } }, env);
  }
  return { get, post, calls };
}

describe("Gmail page (D39)", () => {
  it("not connected: explains the one-sender design and offers Connect", async () => {
    const html = await (await app({ connected: false }).get(`/feeds/${ID}/gmail`)).text();
    expect(html).toContain("one sender");
    expect(html).toContain("read-only");
    expect(html).toContain("Connect Gmail");
  });

  it("Connect sends the owner to Google with read-only scope, offline access and PKCE", async () => {
    const res = await app({ connected: false }).post(`/feeds/${ID}/gmail/connect`, {});
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ref.supabase.co/functions/v1/gmail-oauth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("search shows up to 10 results (sender, subject, date) and the 3/7-day choice only", async () => {
    const t = app({ connected: true, status: "choose_example", candidates: [] });
    const html = await (await t.post(`/feeds/${ID}/gmail/search`, { words: "Room F" })).text();
    expect(html).toContain("November schedule");
    expect(html).toContain("office@school.example");
    expect(html).toContain('value="7"');
    expect(html).toContain('value="3"');
    expect(html).not.toContain('value="14"');
    expect(t.calls.find((c) => c.fn === "invoke:gmail-search")?.args).toEqual({ body: { feed_id: ID, words: "Room F" } });
  });

  it("before saving, it says plainly what Feedcal will do: only that sender, the schedule", async () => {
    const t = app({ connected: true, status: "choose_example", candidates: CANDS });
    const html = await (await t.post(`/feeds/${ID}/gmail/review`, { gmail_id: "abc123", interval: "3" })).text();
    expect(html).toContain("Here's what Feedcal will do");
    expect(html).toContain("from Room F &lt;office@school.example&gt;");
    expect(html).toContain("Nothing else in your Gmail is searched or read");
    expect(html).toContain("every 3 days");
    expect(t.calls.some((c) => c.fn === "gmail_choose_example")).toBe(false); // nothing saved yet
    const done = await t.post(`/feeds/${ID}/gmail/confirm`, { gmail_id: "abc123", interval: "3" });
    expect(done.headers.get("location")).toBe(`/feeds/${ID}/share?ready=gmail`); // D47: straight to "You're set"
    expect(t.calls.find((c) => c.fn === "gmail_choose_example")?.args).toEqual({ p_feed_id: ID, p_gmail_id: "abc123", p_interval_days: 3, p_look_back: false });
  });

  it("the 30-day look-back is offered, ticked, said out loud, and passed on", async () => {
    const t = app({ connected: true, status: "choose_example", candidates: [] });
    const picked = await (await t.post(`/feeds/${ID}/gmail/search`, { words: "Room F" })).text();
    expect(picked).toMatch(/name="look_back" value="1" checked/);
    const t2 = app({ connected: true, status: "choose_example", candidates: CANDS });
    const review = await (await t2.post(`/feeds/${ID}/gmail/review`, { gmail_id: "abc123", interval: "7", look_back: "1" })).text();
    expect(review).toContain("from the 30 days before your example");
    expect(review).toContain('name="look_back" value="1"');
    await t2.post(`/feeds/${ID}/gmail/confirm`, { gmail_id: "abc123", interval: "7", look_back: "1" });
    expect(t2.calls.find((c) => c.fn === "gmail_choose_example")?.args).toEqual({ p_feed_id: ID, p_gmail_id: "abc123", p_interval_days: 7, p_look_back: true });
  });

  it("an active calendar has a Read the last 30 days button", async () => {
    const t = app({ connected: true, status: "active", sender_email: "office@school.example", interval_days: 7 });
    expect(await (await t.get(`/feeds/${ID}/gmail`)).text()).toContain("Read the last 30 days");
    const res = await t.post(`/feeds/${ID}/gmail/look-back`, {});
    expect(res.headers.get("location")).toBe(`/feeds/${ID}/gmail?result=look_back`);
    expect(t.calls.find((c) => c.fn === "gmail_look_back")?.args).toEqual({ p_feed_id: ID });
  });

  it("active: shows the sender, schedule and next check, with disconnect", async () => {
    const html = await (await app({ connected: true, status: "active", google_email: "me@gmail.example", sender_email: "office@school.example", sender_name: "Room F",
      interval_days: 7, last_checked_at: "2026-11-21T19:00:00Z", next_check_at: "2026-11-28T19:00:00Z", reconnect_by: "2026-11-28T18:00:00Z", messages_ingested: 2 }).get(`/feeds/${ID}/gmail`)).text();
    expect(html).toContain("from Room F &lt;office@school.example&gt;</strong> only");
    expect(html).toContain("every 7 days");
    expect(html).toContain("Disconnect Gmail");
  });

  it("disconnecting needs the tick box; without it nothing is deleted", async () => {
    const t = app({ connected: true, status: "active", sender_email: "office@school.example", interval_days: 7 });
    const page = await (await t.get(`/feeds/${ID}/gmail`)).text();
    expect(page).toMatch(/name="confirm" value="yes" required/);
    const res = await t.post(`/feeds/${ID}/gmail/disconnect`, {});
    expect(res.status).toBe(400);
    expect(t.calls.some((c) => c.fn === "gmail_disconnect")).toBe(false);
    await t.post(`/feeds/${ID}/gmail/disconnect`, { confirm: "yes" });
    expect(t.calls.some((c) => c.fn === "gmail_disconnect")).toBe(true);
  });

  it("the example search box is styled like every other field", async () => {
    const html = await (await app({ connected: true, status: "choose_example", candidates: [] }).get(`/feeds/${ID}/gmail`)).text();
    expect(html).toMatch(/<input class="copy" id="words"/);
  });

  it("someone who isn't the owner can't see or change it", async () => {
    const res = await app(null, { owner: false }).get(`/feeds/${ID}/gmail`);
    expect(res.status).toBe(403);
  });
});
