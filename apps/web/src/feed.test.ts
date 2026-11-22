import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { unrecognisedProduct, userAgentFamily } from "./feed.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const BASE = "http://localhost:8788";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };
const TOKEN = "A".repeat(20) + "b_-" + "C".repeat(20); // 43 URL-safe characters
const FEED_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function calendarData(visibility: "public" | "unlisted" | "private" = "private") {
  return {
    feed: { id: FEED_ID, name: "Room 12", slug: "room-12", description: null, visibility, last_updated_at: "2026-11-02T12:00:00Z" },
    events: [
      {
        id: "eeeeeeee-0000-4000-8000-000000000001", uid: "eeeeeeee-0000-4000-8000-000000000001@feedcal.app", title: "Potluck",
        description: null, location: null, starts_at: "2026-11-24T01:00:00Z", ends_at: null, all_day: false,
        timezone: "America/Los_Angeles", rrule: null, status: "confirmed", sequence: 0,
        created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", source: null,
      },
    ],
  };
}

function setup(rpcImpl: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }, user: { sub: string } | null = null) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args));
  const auth = {
    getUser: vi.fn(async () => (user ? { data: { user: { id: user.sub, email: "o@example.test" } }, error: null } : { data: { user: null }, error: { message: "x" } })),
  };
  const logs: string[] = [];
  const app = createApp({ version: "1", commit: "c", supabase: () => ({ rpc, auth }) as unknown as Supa, logSink: (l) => logs.push(l) });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
  return { rpc, request, logs };
}

describe("GET /f/<token>.ics", () => {
  it("serves the calendar with the right headers", async () => {
    const { request, rpc } = setup(() => ({ data: calendarData(), error: null }));
    const res = await request(`/f/${TOKEN}.ics`, { headers: { "user-agent": "Google-Calendar-Importer", "cf-connecting-ip": "203.0.113.7" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=900");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("SUMMARY:Potluck");
    // Long lines are folded (RFC 5545); unfold before matching.
    expect(body.replace(/\r\n /g, "")).toContain(`Report a problem: ${BASE}/report/eeeeeeee-0000-4000-8000-000000000001%40feedcal.app`);
    expect(rpc).toHaveBeenCalledWith("feed_calendar_guarded", {
      p_token: TOKEN, p_ua_family: "google", p_client_ip: "203.0.113.7", p_user_agent: "Google-Calendar-Importer",
    });
  });

  it("the calendar's description tells subscribers it can make mistakes (D44)", async () => {
    const { request } = setup(() => ({ data: calendarData(), error: null }));
    const ics = (await (await request(`/f/${TOKEN}.ics`)).text()).replace(/\r\n[ \t]/g, "");
    expect(ics).toMatch(/X-WR-CALDESC:.*can make mistakes/);
  });

  it("answers 304 when the calendar hasn't changed", async () => {
    const { request } = setup(() => ({ data: calendarData(), error: null }));
    const first = await request(`/f/${TOKEN}.ics`);
    const etag = first.headers.get("etag") ?? "";
    const second = await request(`/f/${TOKEN}.ics`, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("public feeds can be indexed; unlisted and private can't", async () => {
    for (const [visibility, expected] of [["public", null], ["unlisted", "noindex"], ["private", "noindex"]] as const) {
      const { request } = setup(() => ({ data: calendarData(visibility), error: null }));
      expect((await request(`/f/${TOKEN}.ics`)).headers.get("x-robots-tag")).toBe(expected);
    }
  });

  it("an unknown token is a plain 404", async () => {
    const { request } = setup(() => ({ data: null, error: null }));
    const res = await request(`/f/${TOKEN}.ics`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it.each([["/f/short.ics"], [`/f/${TOKEN}`], [`/f/${TOKEN}.json`], [`/f/${TOKEN.slice(1)}!.ics`]])("a malformed path (%s) is a 404 without a database call", async (path) => {
    const { request, rpc } = setup(() => ({ data: calendarData(), error: null }));
    expect((await request(path)).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an unexpected database shape is a 500, not a broken calendar", async () => {
    const { request } = setup(() => ({ data: { feed: { name: 1 } }, error: null }));
    expect((await request(`/f/${TOKEN}.ics`)).status).toBe(500);
  });

  it("never writes the token to the logs", async () => {
    const { request, logs } = setup(() => ({ data: calendarData(), error: null }));
    await request(`/f/${TOKEN}.ics`);
    await request("/f/not-a-token.ics");
    const all = logs.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("not-a-token");
    expect(all).toContain('"path":"/f/[token]"');
  });
});

describe("link rotation", () => {
  it("the old link page redirects to the share kit", async () => {
    const { request } = setup(() => ({ data: null, error: null }));
    const res = await request(`/feeds/${FEED_ID}/link`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/feeds/${FEED_ID}/share`);
  });

  it("rotation needs the CSRF token", async () => {
    const { request, rpc } = setup(() => ({ data: "x".repeat(43), error: null }), { sub: "u1" });
    const res = await request(`/feeds/${FEED_ID}/rotate-token`, { method: "POST", body: new URLSearchParams({}), headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalledWith("rotate_feed_token", expect.anything());
  });

  it("rotation redirects to the share kit (so a refresh can't rotate twice); a non-owner is refused", async () => {
    const csrf = "c".repeat(43);
    const post = (s: ReturnType<typeof setup>, confirm = "yes") =>
      s.request(`/feeds/${FEED_ID}/rotate-token`, { method: "POST", body: new URLSearchParams({ csrf, confirm }), headers: { origin: BASE, cookie: `feedcal_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" } });
    const owner = setup(() => ({ data: "N".repeat(43), error: null }), { sub: "u1" });
    const unticked = await post(owner, "");
    expect(unticked.status).toBe(400); // every subscriber would need the new link: the tick box is required
    expect(owner.rpc).not.toHaveBeenCalledWith("rotate_feed_token", expect.anything());
    const ok = await post(owner);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/feeds/${FEED_ID}/share?rotated=1`);
    expect(owner.rpc).toHaveBeenCalledWith("rotate_feed_token", { p_feed_id: FEED_ID });
    const editor = setup(() => ({ data: null, error: { code: "42501", message: "x" } }), { sub: "u2" });
    expect((await post(editor)).status).toBe(403);
  });
});

describe("userAgentFamily", () => {
  it.each([
    ["Google-Calendar-Importer", "google"],
    ["iOS/18.1 (22B83) dataaccessd/1.0", "apple"],
    ["macOS/15.1 (24B83) CalendarAgent/1000", "apple"],
    ["Microsoft Outlook 16.0", "outlook"],
    ["Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)", "outlook"],
    ["curl/8.7.1", "other"],
    // D52: browsers and crawlers opening the link are not subscribers.
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "other"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "other"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "other"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "other"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "other"],
    [undefined, "other"],
  ])("%s -> %s", (ua, family) => {
    expect(userAgentFamily(ua)).toBe(family);
  });
});

describe("report link", () => {
  it("the link in every event's description opens the report form (Phase 12)", async () => {
    const { request } = setup(() => ({ data: null, error: null }));
    const res = await request("/report/eeeeeeee-0000-4000-8000-000000000001%40feedcal.app");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Report a problem");
    expect(body).toContain('name="kind" value="wrong_details"');
  });
});

describe("unrecognisedProduct (D52)", () => {
  it("keeps only the first product name, nothing personal", () => {
    expect(unrecognisedProduct("Thunderbird/128.0 (Macintosh; me@example.com)")).toBe("Thunderbird/128.0");
    expect(unrecognisedProduct("  Weird<script>App/1 x")).toBe("WeirdscriptApp/1");
    expect(unrecognisedProduct(undefined)).toBe("none");
    expect(unrecognisedProduct("A".repeat(100)).length).toBe(40);
  });
});
