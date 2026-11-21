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
