// D94: the invitation Bumpdraft sends. The route hands the address to public.send_invite and
// says what happened; the stop link works without a session, as an unsubscribe link does.
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const BASE = "http://localhost:8788";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };
const FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const STOP = "ab".repeat(32);

function setup(opts: { signedIn?: boolean; result?: unknown } = {}) {
  const rpc = vi.fn(async (name: string) => ({ data: name === "send_invite" || name === "invite_stop" ? opts.result ?? "sent" : null, error: null }));
  const user = opts.signedIn === false ? null : { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.test" };
  const auth = { getUser: vi.fn(async () => ({ data: { user }, error: user ? null : { message: "x" } })) };
  const app = createApp({ version: "1", commit: "c", supabase: () => ({ rpc, auth }) as unknown as Supa, logSink: () => {} });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
  return { rpc, request };
}

async function csrf(request: (p: string, i?: RequestInit) => Response | Promise<Response>) {
  const res = await request("/contact");
  const cookie = /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const token = /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "";
  return { headers: { cookie: `feedcal_csrf=${cookie}`, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, token };
}

describe("Send the invitation (D94)", () => {
  it("passes the address to send_invite and goes back to the Share page with the result", async () => {
    const { request, rpc } = setup({ result: "sent" });
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/invite`, { method: "POST", headers, body: new URLSearchParams({ csrf: token, email: " pat@example.test " }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/feeds/${FEED}/share?invite=sent#email-it`);
    expect(rpc).toHaveBeenCalledWith("send_invite", { p_feed_id: FEED, p_email: "pat@example.test" });
  });

  it.each(["already", "opted_out", "limit", "busy", "private", "invalid", "not_allowed"])("reports %s as the database said it", async (result) => {
    const { request } = setup({ result });
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/invite`, { method: "POST", headers, body: new URLSearchParams({ csrf: token, email: "pat@example.test" }) });
    expect(res.headers.get("location")).toBe(`/feeds/${FEED}/share?invite=${result}#email-it`);
  });

  it("an answer it doesn't know becomes a plain error, never an open redirect", async () => {
    const { request } = setup({ result: "https://evil.example" });
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/invite`, { method: "POST", headers, body: new URLSearchParams({ csrf: token, email: "pat@example.test" }) });
    expect(res.headers.get("location")).toBe(`/feeds/${FEED}/share?invite=error#email-it`);
  });

  it("needs the form's token, and a signed-in organizer", async () => {
    const a = setup();
    const { headers } = await csrf(a.request);
    const bad = await a.request(`/feeds/${FEED}/invite`, { method: "POST", headers, body: new URLSearchParams({ csrf: "wrong", email: "pat@example.test" }) });
    expect(bad.status).toBe(403);
    expect(a.rpc).not.toHaveBeenCalledWith("send_invite", expect.anything());

    const b = setup({ signedIn: false });
    const form = await csrf(b.request);
    const out = await b.request(`/feeds/${FEED}/invite`, { method: "POST", headers: form.headers, body: new URLSearchParams({ csrf: form.token, email: "pat@example.test" }) });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toContain("/login?next=");
    expect(b.rpc).not.toHaveBeenCalledWith("send_invite", expect.anything());
  });
});

describe("Don't email me again (D94)", () => {
  it("GET only shows a button (link scanners can't opt anyone out)", async () => {
    const { request, rpc } = setup({ result: true });
    const res = await request(`/invite/stop/${STOP}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<form method="post" action="/invite/stop/${STOP}">`);
    expect(html).toContain("Yes, don't email me again");
    expect(rpc).not.toHaveBeenCalledWith("invite_stop", expect.anything());
  });

  it("POST works with no cookie and no Origin, as a mail app's one-click does", async () => {
    const { request, rpc } = setup({ result: true });
    const res = await request(`/invite/stop/${STOP}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("email this address another invitation");
    expect(rpc).toHaveBeenCalledWith("invite_stop", { p_token: STOP });
  });

  it("a code nobody was sent, or a malformed one, is refused", async () => {
    const a = setup({ result: false });
    expect((await a.request(`/invite/stop/${STOP}`, { method: "POST" })).status).toBe(400);
    const b = setup({ result: true });
    expect((await b.request("/invite/stop/nope")).status).toBe(400);
    expect((await b.request("/invite/stop/nope", { method: "POST" })).status).not.toBe(200);
    expect(b.rpc).not.toHaveBeenCalledWith("invite_stop", expect.anything());
  });
});
