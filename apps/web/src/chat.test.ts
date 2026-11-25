// D89: the event chat's pages. The rules themselves (limits, no links, closing) are the
// database's and are tested in supabase/tests/036_event_chat.test.sql.
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { APP_JS } from "./assets.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const BASE = "http://localhost:8788";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };
const UID = "eeeeeeee-0000-4000-8000-000000000001@feedcal.app";
const PATH = `/chat/${encodeURIComponent(UID)}`;
const M1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const M2 = "aaaaaaaa-0000-4000-8000-0000000000a2";

const data = (over: Record<string, unknown> = {}) => ({
  event: { title: "Movie night", calendar: "Room 12", starts_at: "2026-11-24T17:00:00Z", ends_at: null, all_day: false, timezone: "America/Los_Angeles" },
  open: true, on: true, moderator: false,
  messages: [
    { id: M1, name: "Blue Heron", body: "Is there <b>parking</b>?", at: "2026-11-23T17:00:00Z", organizer: false },
    { id: M2, name: "Organizer", body: "Yes, behind the gym.", at: "2026-11-23T17:05:00Z", organizer: true },
  ],
  ...over,
});
function setup(page: unknown = data(), result: unknown = "ok") {
  const rpc = vi.fn(async (fn: string) => ({ data: fn === "chat_page" ? page : result, error: null }));
  const auth = { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "x" } })) };
  const app = createApp({ version: "1", commit: "c", supabase: () => ({ rpc, auth }) as unknown as Supa, logSink: () => {} });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
  return { rpc, request };
}
async function open(request: (p: string, i?: RequestInit) => Response | Promise<Response>) {
  const res = await request(PATH);
  const cookie = /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const html = await res.text();
  return { res, html, headers: { cookie: `feedcal_csrf=${cookie}`, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}

describe("event chat (D89)", () => {
  it("shows the event, the messages escaped, a Report button on followers' messages only, and the form", async () => {
    const { request } = setup();
    const { res, html } = await open(request);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Is there &lt;b&gt;parking&lt;/b&gt;?");
    expect(html).toContain("<strong>Blue Heron</strong>");
    expect(html).toContain(`action="/chat/${UID}/report/${M1}"`);
    expect(html).not.toContain(`/report/${M2}`);
    expect(html).not.toContain("/remove/");
    expect(html).toContain(`data-live="/chat/${UID}/messages"`);
    expect(html).toContain("You&#39;re anonymous here");
    expect(html).toContain("may be wrong");
  });

  it("the organizer sees Remove on every message instead of Report", async () => {
    const { html } = await open(setup(data({ moderator: true })).request);
    expect(html).toContain(`action="/chat/${UID}/remove/${M1}"`);
    expect(html).toContain(`action="/chat/${UID}/remove/${M2}"`);
    expect(html).not.toContain("/report/");
    expect(html).toContain("your messages show as Organizer");
  });

  it("closed or switched off: no form, no live refresh; a private calendar shows no title", async () => {
    const over = (await open(setup(data({ open: false })).request)).html;
    expect(over).toContain("This chat is closed because the event is over.");
    expect(over).not.toContain('name="message"');
    expect(over).not.toContain("data-live");
    const off = (await open(setup(data({ open: false, on: false, messages: [] })).request)).html;
    expect(off).toContain("The organizer has switched this chat off.");
    expect(off).not.toContain('id="chat"');
    const priv = (await open(setup(data({ event: { ...data().event, title: null, calendar: null } })).request)).html;
    expect(priv).toContain("An event on a private calendar");
  });

  it("no chat for the event, or a bad link, is a 404", async () => {
    const { request } = setup(null);
    expect((await request(PATH)).status).toBe(404);
    expect((await request("/chat/not-a-uid")).status).toBe(404);
    expect((await request(`${PATH}/messages`)).status).toBe(404);
  });

  it("posts with the client IP for the limits, then goes back to the chat", async () => {
    const { request, rpc } = setup();
    const t = await open(request);
    const res = await request(PATH, { method: "POST", headers: { ...t.headers, "cf-connecting-ip": "198.51.100.9" }, body: new URLSearchParams({ csrf: t.csrf, message: "See you there" }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PATH);
    expect(rpc).toHaveBeenCalledWith("chat_post", { p_event_uid: UID, p_body: "See you there", p_client_ip: "198.51.100.9" });
  });

  it("says why a message was refused, and refuses a forged form", async () => {
    for (const [why, status, text] of [["no_links", 400, "Links and website names"], ["slow_down", 429, "wait a few seconds"], ["closed", 400, "This chat is closed."]] as const) {
      const { request } = setup(data(), why);
      const t = await open(request);
      const res = await request(PATH, { method: "POST", headers: t.headers, body: new URLSearchParams({ csrf: t.csrf, message: "x" }) });
      expect(res.status).toBe(status);
      expect(await res.text()).toContain(text);
    }
    const forged = setup();
    const t = await open(forged.request);
    expect((await forged.request(PATH, { method: "POST", headers: t.headers, body: new URLSearchParams({ message: "x" }) })).status).toBe(403);
    expect(forged.rpc).not.toHaveBeenCalledWith("chat_post", expect.anything());
  });

  it("report and remove call their functions and return to the chat with a note", async () => {
    const { request, rpc } = setup(data(), true);
    const t = await open(request);
    const rep = await request(`${PATH}/report/${M1}`, { method: "POST", headers: { ...t.headers, "cf-connecting-ip": "198.51.100.9" }, body: new URLSearchParams({ csrf: t.csrf }) });
    expect(rep.headers.get("location")).toBe(`${PATH}?done=reported`);
    expect(rpc).toHaveBeenCalledWith("chat_report", { p_message_id: M1, p_client_ip: "198.51.100.9" });
    const rem = await request(`${PATH}/remove/${M1}`, { method: "POST", headers: t.headers, body: new URLSearchParams({ csrf: t.csrf }) });
    expect(rem.headers.get("location")).toBe(`${PATH}?done=removed`);
    expect(rpc).toHaveBeenCalledWith("chat_remove", { p_message_id: M1 });
    expect((await request(`${PATH}/remove/${M1}`, { method: "POST", headers: t.headers, body: new URLSearchParams({}) })).status).toBe(403);
    expect(await (await request(`${PATH}?done=reported`)).text()).toContain("a message several people report is hidden");
  });

  it("the list alone is served for the page's refresh, and the page script asks for it", async () => {
    const { request } = setup();
    const res = await request(`${PATH}/messages`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("<strong>Blue Heron</strong>");
    expect(html).not.toContain("<html");
    expect(APP_JS).toContain("list.dataset.live");
    expect(APP_JS).toContain("setInterval(tick, 5000)");
  });
});
