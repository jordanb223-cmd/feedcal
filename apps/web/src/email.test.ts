import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { EMAIL_NOTICES } from "./email-views.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const BASE = "http://localhost:8788";
const FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const SOURCE = "cccccccc-0000-4000-8000-000000000009";
const MSG = "dddddddd-0000-4000-8000-000000000009";
const OWNER = "11111111-1111-4111-8111-111111111111";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon", INTAKE_DOMAIN: "in.feedcal.test" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A query builder fake: chain methods record their arguments; awaiting gives rows picked by `pick`. */
type Call = [string, unknown[]];
function table(pick: (calls: Call[]) => unknown[]) {
  const calls: Call[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "gt", "order", "limit", "is", "neq", "in"]) q[m] = (...args: unknown[]) => (calls.push([m, args]), q);
  q.maybeSingle = async () => ({ data: pick(calls)[0] ?? null, error: null });
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data: pick(calls), error: null });
  return q;
}
const isRecentQuery = (calls: Call[]) => calls.some(([m]) => m === "is");

function setup(opts: { user?: string | null; feed?: unknown; messages?: unknown[]; recent?: unknown[]; attachments?: unknown[]; confirmations?: unknown[]; rpcError?: boolean; env?: Partial<Bindings> } = {}) {
  const user = opts.user === undefined ? OWNER : opts.user;
  const auth = { getUser: vi.fn(async () => (user ? { data: { user: { id: user, email: "o@example.test" } }, error: null } : { data: { user: null }, error: { message: "x" } })) };
  const feeds = opts.feed === undefined ? [{ id: FEED, name: "Sutterville Kindergarten", owner_id: OWNER, intake_address: "feed-aliceschoolfeed23456" }] : opts.feed ? [opts.feed] : [];
  const from = vi.fn((name: string) => table((calls) => {
    if (name === "feeds") return feeds;
    if (name === "messages") return isRecentQuery(calls) ? opts.recent ?? [] : opts.messages ?? [];
    if (name === "attachments") return opts.attachments ?? [];
    if (name === "forwarding_confirmations") return opts.confirmations ?? [];
    return [];
  }));
  const rpc = vi.fn(async () => ({ data: true, error: opts.rpcError ? { code: "P0002" } : null }));
  const createSignedUrls = vi.fn(async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `http://db.test/sign/${path}?token=t` })), error: null }));
  const storage = { from: vi.fn(() => ({ createSignedUrls })) };
  const app = createApp({ version: "1", commit: "c", supabase: () => ({ auth, from, rpc, storage }) as unknown as Supa, logSink: () => {} });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, { ...env, ...opts.env });
  return { request, rpc, createSignedUrls };
}

async function csrf(request: (p: string, i?: RequestInit) => Response | Promise<Response>) {
  const res = await request(`/feeds/${FEED}/email`);
  const cookie = /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const token = /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "";
  return { headers: { cookie: `feedcal_csrf=${cookie}`, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, token };
}

const waiting = [
  { id: "m1", source_id: SOURCE, sender: "chair@pta.example.test", subject: "Bake <b>sale</b>", received_at: "2026-11-21T10:00:00Z", quarantine_reason: "new_sender" },
  { id: "m2", source_id: SOURCE, sender: "chair@pta.example.test", subject: "Older", received_at: "2026-11-20T10:00:00Z", quarantine_reason: "new_sender" },
  { id: MSG, source_id: null, sender: "office@school.example.test", subject: "Urgent: pay now", received_at: "2026-11-21T09:00:00Z", quarantine_reason: "failed_authentication" },
];

describe("GET /feeds/<id>/email", () => {
  it("sends signed-out people to sign in, then back here", async () => {
    const res = await setup({ user: null }).request(`/feeds/${FEED}/email`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/feeds/${FEED}/email`)}`);
  });

  it("is a 404 for anyone who isn't an owner or editor (RLS hides the feed)", async () => {
    expect((await setup({ feed: null }).request(`/feeds/${FEED}/email`)).status).toBe(404);
  });

  it("shows the address, the Gmail code, waiting senders and suspicious mail", async () => {
    const { request } = setup({
      messages: waiting,
      confirmations: [{ code: "957493560", confirm_url: "https://mail-settings.google.com/mail/vf-abc", requested_by: "parent@gmail.example", expires_at: "2026-11-28T00:00:00Z" }],
    });
    const body = await (await request(`/feeds/${FEED}/email`)).text();
    expect(body).toContain('value="feed-aliceschoolfeed23456@in.feedcal.test"');
    expect(body).toContain("957493560");
    expect(body).toContain("Confirm on google.com");
    expect(body).toContain('href="https://mail-settings.google.com/mail/vf-abc" rel="noreferrer noopener"');
    expect(body).toContain("Use emails from chair@pta.example.test for this calendar?");
    expect(body).toContain("2 emails waiting");
    expect(body).toContain(esc("Bake <b>sale</b>"));
    expect(body).not.toContain("<b>sale</b>");
    expect(body).toContain("didn't pass the sender's security checks");
    expect(body).toContain("Get a new address");
  });

  it("an editor doesn't get the owner-only button", async () => {
    const { request } = setup({ user: "22222222-2222-4222-8222-222222222222" });
    expect(await (await request(`/feeds/${FEED}/email`)).text()).not.toContain("Get a new address");
  });

  it("says plainly when forwarding isn't switched on for this site", async () => {
    const { request } = setup({ env: { INTAKE_DOMAIN: "" } });
    const body = await (await request(`/feeds/${FEED}/email`)).text();
    expect(body).toContain("isn't switched on for this site yet");
    expect(body).not.toContain('id="intake"');
  });

  it("has an empty state", async () => {
    expect(await (await setup().request(`/feeds/${FEED}/email`)).text()).toContain("Nothing is waiting.");
  });

  it("shows only known notices", async () => {
    const { request } = setup();
    expect(await (await request(`/feeds/${FEED}/email?done=approved`)).text()).toContain(EMAIL_NOTICES.approved);
    const body = await (await request(`/feeds/${FEED}/email?done=%3Cscript%3Ealert(1)%3C%2Fscript%3E`)).text();
    expect(body).not.toContain("alert(1)");
    expect(body).not.toContain('role="status"');
  });
});

const recentEmail = { id: "m9", source_id: SOURCE, original_subject: "November newsletter", subject: "Fwd: November newsletter", original_sender: "office@school.example.test", sender: "parent@home.example.test", received_at: "2026-11-21T10:00:00Z", status: "parsed", pages_for_ai: 2 };
const ATT = "eeeeeeee-0000-4000-8000-000000000009";

describe("recent emails (Phase 8)", () => {
  it("says what was read from each file, with feedback buttons and a photo thumbnail", async () => {
    const { request, createSignedUrls } = setup({
      recent: [recentEmail],
      attachments: [
        { id: ATT, message_id: "m9", filename: "newsletter.pdf", mime: "application/pdf", status: "text_layer", chosen: false, pages: 40, triage: { reason: "text_layer", keptPages: [16, 17] }, storage_path: "f/m9/a" },
        { id: "a2", message_id: "m9", filename: "flyer.jpg", mime: "image/jpeg", status: "pending", chosen: false, pages: 1, triage: { reason: "needs_vision_not_configured" }, storage_path: "f/m9/b" },
        { id: "a3", message_id: "m9", filename: "yearbook.pdf", mime: "application/pdf", status: "skipped", chosen: false, pages: 120, triage: { reason: "too_many_pages" }, storage_path: "f/m9/c" },
      ],
    });
    const body = await (await request(`/feeds/${FEED}/email`)).text();
    expect(body).toContain("November newsletter");
    expect(body).toContain("Reading pages 17 and 18 of 40");
    expect(body).toContain("Waiting: reading images and scans isn&#39;t switched on yet"); // escaped text from data
    expect(body).toContain("Skipped: over 40 pages (120)");
    expect(body).toContain(`action="/feeds/${FEED}/attachments/${ATT}/choose"`);
    expect(body).toContain(`action="/feeds/${FEED}/senders/${SOURCE}/large"`);
    expect(body).toContain('src="http://db.test/sign/f/m9/b?token=t"');
    expect(createSignedUrls).toHaveBeenCalledWith(["f/m9/b"], 600);
  });

  it("has an empty state", async () => {
    expect(await (await setup().request(`/feeds/${FEED}/email`)).text()).toContain("No emails yet.");
  });

  it("'this one has the schedule' calls choose_attachment and redirects", async () => {
    const { request, rpc } = setup();
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/attachments/${ATT}/choose`, { method: "POST", headers, body: new URLSearchParams({ csrf: token }) });
    expect(res.headers.get("location")).toBe(`/feeds/${FEED}/email?done=chosen`);
    expect(rpc).toHaveBeenCalledWith("choose_attachment", { p_attachment_id: ATT });
  });

  it("'never use files like this' and 'read big files' need CSRF and call the database", async () => {
    const { request, rpc } = setup();
    const { headers, token } = await csrf(request);
    expect((await request(`/feeds/${FEED}/attachments/${ATT}/never`, { method: "POST", headers, body: new URLSearchParams({}) })).status).toBe(403);
    await request(`/feeds/${FEED}/attachments/${ATT}/never`, { method: "POST", headers, body: new URLSearchParams({ csrf: token }) });
    await request(`/feeds/${FEED}/senders/${SOURCE}/large`, { method: "POST", headers, body: new URLSearchParams({ csrf: token }) });
    expect(rpc).toHaveBeenCalledWith("never_use_attachment", { p_attachment_id: ATT });
    expect(rpc).toHaveBeenCalledWith("set_sender_large_attachments", { p_source_id: SOURCE, p_allow: true });
  });
});

describe("decisions", () => {
  it("approving a sender calls decide_sender and redirects (PRG)", async () => {
    const { request, rpc } = setup();
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/senders/${SOURCE}`, { method: "POST", headers, body: new URLSearchParams({ csrf: token, decision: "yes" }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/feeds/${FEED}/email?done=approved`);
    expect(rpc).toHaveBeenCalledWith("decide_sender", { p_source_id: SOURCE, p_trust: true });
  });

  it("refuses a decision without the CSRF token", async () => {
    const { request, rpc } = setup();
    const { headers } = await csrf(request);
    const res = await request(`/feeds/${FEED}/senders/${SOURCE}`, { method: "POST", headers, body: new URLSearchParams({ decision: "yes" }) });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a stranger's decision is a 404 (the database refuses it)", async () => {
    const { request } = setup({ rpcError: true });
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/senders/${SOURCE}`, { method: "POST", headers, body: new URLSearchParams({ csrf: token, decision: "no" }) });
    expect(res.status).toBe(404);
  });

  it("ignoring one suspicious email; a double tap just lands back on the page", async () => {
    const { request, rpc } = setup();
    const { headers, token } = await csrf(request);
    const res = await request(`/feeds/${FEED}/messages/${MSG}`, { method: "POST", headers, body: new URLSearchParams({ csrf: token, decision: "ignore" }) });
    expect(res.headers.get("location")).toBe(`/feeds/${FEED}/email?done=ignored`);
    expect(rpc).toHaveBeenCalledWith("decide_message", { p_message_id: MSG, p_release: false });

    const again = setup({ rpcError: true });
    const c2 = await csrf(again.request);
    const res2 = await again.request(`/feeds/${FEED}/messages/${MSG}`, { method: "POST", headers: c2.headers, body: new URLSearchParams({ csrf: c2.token, decision: "ignore" }) });
    expect(res2.status).toBe(303);
    expect(res2.headers.get("location")).toBe(`/feeds/${FEED}/email`);
  });

  it("rotating the address: owner ok, otherwise a plain refusal", async () => {
    const ok = setup();
    const c1 = await csrf(ok.request);
    const r0 = await ok.request(`/feeds/${FEED}/rotate-intake`, { method: "POST", headers: c1.headers, body: new URLSearchParams({ csrf: c1.token }) });
    expect(r0.status).toBe(400); // can't be undone, so the tick box is required
    expect(await r0.text()).toContain("Nothing changed");
    const r1 = await ok.request(`/feeds/${FEED}/rotate-intake`, { method: "POST", headers: c1.headers, body: new URLSearchParams({ csrf: c1.token, confirm: "yes" }) });
    expect(r1.headers.get("location")).toBe(`/feeds/${FEED}/email?done=rotated`);
    const no = setup({ rpcError: true });
    const c2 = await csrf(no.request);
    const r2 = await no.request(`/feeds/${FEED}/rotate-intake`, { method: "POST", headers: c2.headers, body: new URLSearchParams({ csrf: c2.token, confirm: "yes" }) });
    expect(r2.status).toBe(403);
  });
});
