import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const BASE = "http://localhost:8788";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };
const UID = "eeeeeeee-0000-4000-8000-000000000001@feedcal.app";
const USER = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(64);

function setup(result: unknown = "ok") {
  const rpc = vi.fn(async () => ({ data: result, error: null }));
  const auth = { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "x" } })) };
  const app = createApp({ version: "1", commit: "c", supabase: () => ({ rpc, auth }) as unknown as Supa, logSink: () => {} });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
  return { rpc, request };
}

async function csrf(request: (p: string, i?: RequestInit) => Response | Promise<Response>) {
  const res = await request(`/report/${encodeURIComponent(UID)}`);
  const cookie = /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const token = /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "";
  return { headers: { cookie: `feedcal_csrf=${cookie}`, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, token };
}

describe("Report a problem (subscribers, no account)", () => {
  it("sends the report with the client IP for rate limiting, and thanks the reporter", async () => {
    const { request, rpc } = setup("ok");
    const { headers, token } = await csrf(request);
    const res = await request(`/report/${encodeURIComponent(UID)}`, { method: "POST", headers: { ...headers, "cf-connecting-ip": "198.51.100.9" },
      body: new URLSearchParams({ csrf: token, kind: "wrong_details", details: "It's at 9:30" }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your report was sent");
    expect(rpc).toHaveBeenCalledWith("submit_report", { p_event_uid: UID, p_kind: "wrong_details", p_details: "It's at 9:30", p_client_ip: "198.51.100.9" });
  });

  it("says plainly when rate limited, and refuses a forged form", async () => {
    const limited = setup("rate_limited");
    const c1 = await csrf(limited.request);
    expect((await limited.request(`/report/${encodeURIComponent(UID)}`, { method: "POST", headers: c1.headers, body: new URLSearchParams({ csrf: c1.token, kind: "spam" }) })).status).toBe(429);
    const forged = setup();
    const c2 = await csrf(forged.request);
    expect((await forged.request(`/report/${encodeURIComponent(UID)}`, { method: "POST", headers: c2.headers, body: new URLSearchParams({ kind: "spam" }) })).status).toBe(403);
    expect(forged.rpc).not.toHaveBeenCalled();
  });
});

describe("unsubscribe", () => {
  const q = `/unsubscribe?u=${USER}&k=weekly_digest&t=${TOKEN}`;
  it("GET only shows a button (link scanners can't unsubscribe anyone)", async () => {
    const { request, rpc } = setup(true);
    const body = await (await request(q)).text();
    expect(body).toContain("Stop the weekly summary?");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("one-click POST works without an Origin header (RFC 8058), using the signed token", async () => {
    const { request, rpc } = setup(true);
    const res = await request(q, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("unsubscribe", { p_user: USER, p_kind: "weekly_digest", p_token: TOKEN });
  });

  it("a bad token is refused, and other POSTs still need the same origin", async () => {
    const { request } = setup(false);
    expect((await request(q, { method: "POST" })).status).toBe(400);
    expect((await request("/account/notifications", { method: "POST" })).status).toBe(403);
  });
});

describe("Ask the organizer (D88; followers, no account)", () => {
  const pageData = (over: Record<string, unknown> = {}) => ({
    event: { title: "Field trip <b>", calendar: "Room 12", starts_at: "2026-11-24T17:00:00Z", ends_at: null, all_day: false, timezone: "America/Los_Angeles", ...over },
    answered: [{ question: "Packed lunch?", answer: "Yes, and <water>.", answered_at: "2026-11-22T17:00:00Z" }],
  });
  function ask(result: unknown = "ok", page: unknown = pageData()) {
    const rpc = vi.fn(async (fn: string) => ({ data: fn === "event_questions_page" ? page : result, error: null }));
    const auth = { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "x" } })) };
    const app = createApp({ version: "1", commit: "c", supabase: () => ({ rpc, auth }) as unknown as Supa, logSink: () => {} });
    const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
    return { rpc, request };
  }
  const PATH = `/ask/${encodeURIComponent(UID)}`;
  async function token(request: (p: string, i?: RequestInit) => Response | Promise<Response>) {
    const res = await request(PATH);
    const cookie = /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const html = await res.text();
    return { res, html, headers: { cookie: `feedcal_csrf=${cookie}`, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
  }

  it("shows the event, the answered questions and a form; everything escaped", async () => {
    const { request } = ask();
    const { res, html } = await token(request);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    // "no-referrer" would make the browser send "Origin: null" with the form, which the same-site check refuses.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(html).toContain("Field trip &lt;b&gt;");
    expect(html).toContain("Tue, Nov 24 · 9:00 AM PST");
    expect(html).toContain("<dt dir=\"auto\">Packed lunch?</dt><dd dir=\"auto\">Yes, and &lt;water&gt;.</dd>");
    expect(html).toContain("Only the person who runs this calendar sees your question.");
  });

  it("a private calendar's event shows no title or calendar name", async () => {
    const { request } = ask("ok", { ...pageData({ title: null, calendar: null }), answered: [] });
    const { html } = await token(request);
    expect(html).toContain("An event on a private calendar");
    expect(html).toContain("No answers yet.");
  });

  it("sends the question with the client IP for the limit, and says where it went", async () => {
    const { request, rpc } = ask("ok");
    const t = await token(request);
    const res = await request(PATH, { method: "POST", headers: { ...t.headers, "cf-connecting-ip": "198.51.100.9" }, body: new URLSearchParams({ csrf: t.csrf, question: "  What time is pickup?  " }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your question went to the person who runs this calendar.");
    expect(rpc).toHaveBeenCalledWith("ask_question", { p_event_uid: UID, p_body: "What time is pickup?", p_client_ip: "198.51.100.9" });
  });

  it("refuses an empty question, a forged form, too many, and an unknown event", async () => {
    const a = ask();
    const t = await token(a.request);
    expect((await a.request(PATH, { method: "POST", headers: t.headers, body: new URLSearchParams({ csrf: t.csrf, question: "   " }) })).status).toBe(400);
    expect((await a.request(PATH, { method: "POST", headers: t.headers, body: new URLSearchParams({ question: "Hi?" }) })).status).toBe(403);
    expect(a.rpc).not.toHaveBeenCalledWith("ask_question", expect.anything());
    for (const r of ["rate_limited", "full"]) {
      const b = ask(r);
      const tb = await token(b.request);
      expect((await b.request(PATH, { method: "POST", headers: tb.headers, body: new URLSearchParams({ csrf: tb.csrf, question: "Hi?" }) })).status).toBe(429);
    }
    const gone = ask("ok", null);
    expect((await gone.request(PATH)).status).toBe(404);
    expect((await gone.request("/ask/not-a-uid")).status).toBe(404);
  });
});
