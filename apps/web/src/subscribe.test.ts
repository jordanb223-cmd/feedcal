import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import { detectDevice, subscribeLinks } from "./subscribe-links.js";
import { formatWhen } from "./subscribe-views.js";
import type { Supa } from "./types.js";

const BASE = "https://feedcal.example";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };
const TOKEN = "T".repeat(43);
const FEED_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");

function page(visibility: "public" | "unlisted" = "public", events = 7, subscribers = 43) {
  return {
    feed: {
      id: FEED_ID, name: "Sutterville Kindergarten", slug: "sutterville-kindergarten", description: "Class events & field trips",
      category: "school", zip_code: "95818", area: null, visibility, last_updated_at: "2026-11-20T12:00:00Z",
      organizer_name: "Alice O'Brien", subscribers_at_least: subscribers, feed_token: TOKEN,
    },
    events: Array.from({ length: events }, (_, i) => ({
      id: `eeeeeeee-0000-4000-8000-00000000000${i}`, uid: `u${i}@feedcal.app`, title: `Event ${i + 1}`, description: null,
      location: i === 0 ? "Room 12" : null, starts_at: `2026-11-${24 + i}T01:00:00Z`, ends_at: null, all_day: false,
      timezone: "America/Los_Angeles", rrule: null, status: "confirmed",
    })),
  };
}

function setup(rpcImpl: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }, opts: { user?: boolean; feedRow?: unknown } = {}) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args));
  const auth = { getUser: vi.fn(async () => (opts.user ? { data: { user: { id: "u1", email: "o@example.test" } }, error: null } : { data: { user: null }, error: { message: "x" } })) };
  const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.feedRow ?? null }) }) }) }));
  const app = createApp({ version: "1", commit: "c", supabase: () => ({ rpc, auth, from }) as unknown as Supa, logSink: () => {} });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
  return { rpc, request };
}

describe("subscribe links", () => {
  const l = subscribeLinks(`${BASE}/f/${TOKEN}.ics`, "Room 12 & Friends");
  it("builds webcal and each app's add-by-URL link", () => {
    expect(l.webcal).toBe(`webcal://feedcal.example/f/${TOKEN}.ics`);
    expect(l.google).toBe(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(l.webcal)}`);
    expect(l.outlook).toBe(`https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(l.webcal)}&name=Room%2012%20%26%20Friends`);
    expect(l.office365.startsWith("https://outlook.office.com/calendar/0/addfromweb?url=")).toBe(true);
  });
  it.each([[IPHONE, "apple"], ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", "apple"], [ANDROID, "android"], ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows"], ["curl/8", "other"], [undefined, "other"]])(
    "%s -> %s", (ua, device) => expect(detectDevice(ua)).toBe(device),
  );
});

describe("formatWhen", () => {
  it("shows the time in the event's own zone", () => {
    expect(formatWhen({ starts_at: "2026-11-24T01:00:00Z", all_day: false, timezone: "America/Los_Angeles" })).toBe("Mon, Nov 23 · 5:00 PM PST");
    expect(formatWhen({ starts_at: "2026-11-25T20:00:00Z", all_day: true, timezone: "America/Los_Angeles" })).toBe("Wed, Nov 25 · All day");
  });
});

describe("GET /c/<slug>", () => {
  it("shows the feed, the next 5 events, the count and how it's made", async () => {
    const { request } = setup(() => ({ data: page(), error: null }));
    const res = await request("/c/sutterville-kindergarten", { headers: { "user-agent": IPHONE } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<h1 dir="auto">Sutterville Kindergarten</h1>');
    expect(body).toContain(`Kept up to date by <span dir="auto">${esc("Alice O'Brien")}</span> · 95818`);
    expect(body).toContain("At least 43 calendars follow this.");
    expect(body).toContain("How we count");
    expect((body.match(/<li><strong dir="auto">Event/g) ?? []).length).toBe(5);
    expect(body).toContain("Room 12");
  });

  it.each([
    ["Arabic", "حفل الشتاء"],
    ["Hebrew", "מסיבת חורף"],
    ["emoji", "🎄 Winter concert 🎶"],
  ])("renders a %s title as written, marked dir=auto", async (_name, title) => {
    const p = page();
    p.feed.name = title;
    p.events = p.events.map((e, i) => (i === 0 ? { ...e, title } : e));
    const { request } = setup(() => ({ data: p, error: null }));
    const body = await (await request("/c/sutterville-kindergarten")).text();
    expect(body).toContain(`<h1 dir="auto">${title}</h1>`);
    expect(body).toContain(`<strong dir="auto">${title}</strong>`);
    expect(body).toContain(`<meta property="og:title" content="${title}">`);
  });

  it("puts the right button first for the device, and always lists the others", async () => {
    const { request } = setup(() => ({ data: page(), error: null }));
    const iphone = await (await request("/c/sutterville-kindergarten", { headers: { "user-agent": IPHONE } })).text();
    expect(iphone).toMatch(/<a class="button wide" href="\/c\/sutterville-kindergarten\/go\/apple">Add to Apple Calendar<\/a>/);
    const android = await (await request("/c/sutterville-kindergarten", { headers: { "user-agent": ANDROID } })).text();
    expect(android).toMatch(/<a class="button wide" href="\/c\/sutterville-kindergarten\/go\/google">Add to Google Calendar<\/a>/);
    for (const t of ["apple", "google", "outlook", "office365"]) expect(android).toContain(`/c/sutterville-kindergarten/go/${t}`);
    expect(android).toContain(`value="${BASE}/f/${TOKEN}.ics"`);
    expect(android).toContain("Other calendars → + → From URL");
  });

  it("has link-preview tags, escaped", async () => {
    const { request } = setup(() => ({ data: page(), error: null }));
    const body = await (await request("/c/sutterville-kindergarten")).text();
    expect(body).toContain('<meta property="og:title" content="Sutterville Kindergarten">');
    expect(body).toContain('<meta property="og:description" content="Class events &amp; field trips">');
    expect(body).toContain(`<meta property="og:url" content="${BASE}/c/sutterville-kindergarten">`);
    expect(body).not.toContain('name="robots"');
  });

  it("an unlisted page is kept out of search engines", async () => {
    const { request } = setup(() => ({ data: page("unlisted"), error: null }));
    const res = await request("/c/sutterville-kindergarten");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toContain('<meta name="robots" content="noindex">');
  });

  it("a feed with no events and no subscribers still reads well", async () => {
    const { request } = setup(() => ({ data: page("public", 0, 0), error: null }));
    const body = await (await request("/c/sutterville-kindergarten")).text();
    expect(body).toContain("No upcoming events yet");
    expect(body).not.toContain("At least 0");
  });

  it("private or unknown feeds are a friendly 404", async () => {
    const { request } = setup(() => ({ data: null, error: null }));
    const res = await request("/c/some-private-feed");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Calendar not found");
  });

  it("a malformed slug never reaches the database", async () => {
    const { request, rpc } = setup(() => ({ data: page(), error: null }));
    expect((await request("/c/Not_A_Slug!")).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("subscribe buttons", () => {
  it.each([
    ["apple", "apple", `webcal://feedcal.example/f/${TOKEN}.ics`],
    ["google", "google", "https://calendar.google.com/calendar/r?cid="],
    ["outlook", "outlook", "https://outlook.live.com/calendar/0/addfromweb?url="],
    ["office365", "outlook", "https://outlook.office.com/calendar/0/addfromweb?url="],
  ])("%s counts a tap as %s and hands off to the app", async (target, platform, prefix) => {
    const { request, rpc } = setup((fn) => (fn === "public_feed_page" ? { data: page(), error: null } : { data: true, error: null }));
    const res = await request(`/c/sutterville-kindergarten/go/${target}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith(prefix)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("record_subscribe_click", { p_slug: "sutterville-kindergarten", p_platform: platform });
  });

  it("an unknown button is a 404 and counts nothing", async () => {
    const { request, rpc } = setup(() => ({ data: page(), error: null }));
    expect((await request("/c/sutterville-kindergarten/go/myspace")).status).toBe(404);
    expect(rpc).not.toHaveBeenCalledWith("record_subscribe_click", expect.anything());
  });

  it("the copy button's tap is counted", async () => {
    const { request, rpc } = setup(() => ({ data: true, error: null }));
    const res = await request("/c/sutterville-kindergarten/copied", { method: "POST", headers: { origin: BASE } });
    expect(res.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("record_subscribe_click", { p_slug: "sutterville-kindergarten", p_platform: "copy_link" });
  });
});

describe("share kit", () => {
  const kitRpc = (fn: string) =>
    fn === "get_feed_token" ? { data: TOKEN, error: null }
    : fn === "feed_subscribe_stats" ? { data: { subscribers_at_least: 12, clicks_30d: { apple: 3, google: 2 } }, error: null }
    : { data: null, error: null };

  it("sends signed-out people to sign in", async () => {
    const { request } = setup(kitRpc);
    const res = await request(`/feeds/${FEED_ID}/share`);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/feeds/${FEED_ID}/share`)}`);
  });

  it("shows the page link, calendar link, QR code, chat text and stats", async () => {
    const { request } = setup(kitRpc, { user: true, feedRow: { id: FEED_ID, name: "Room 12", slug: "room-12-ab12cd34", visibility: "unlisted" } });
    const body = await (await request(`/feeds/${FEED_ID}/share`)).text();
    expect(body).toContain(`value="${BASE}/c/room-12-ab12cd34"`);
    expect(body).toContain(`value="${BASE}/f/${TOKEN}.ics"`);
    expect(body).toMatch(/<svg[^>]*>/);
    expect(body).toContain(`Get Room 12 in your phone&#39;s calendar. It updates on its own: ${BASE}/c/room-12-ab12cd34`);
    expect(body).toContain("At least 12 calendars checked this feed");
    expect(body).toContain("tapped 5 times");
    expect(body).toContain(`action="/feeds/${FEED_ID}/rotate-token"`);
  });

  it("a private feed's kit has no page link, and its QR points at the calendar link", async () => {
    const { request } = setup(kitRpc, { user: true, feedRow: { id: FEED_ID, name: "Drafts", slug: "drafts", visibility: "private" } });
    const body = await (await request(`/feeds/${FEED_ID}/share`)).text();
    expect(body).toContain("This feed is private");
    expect(body).not.toContain("/c/drafts");
    expect(body).toContain(`aria-label="QR code for ${BASE}/f/${TOKEN}.ics"`);
  });

  it("says when the link was just rotated", async () => {
    const { request } = setup(kitRpc, { user: true, feedRow: { id: FEED_ID, name: "Room 12", slug: "room-12", visibility: "public" } });
    expect(await (await request(`/feeds/${FEED_ID}/share?rotated=1`)).text()).toContain("The old link has stopped working");
  });

  it("someone else's feed is a 404", async () => {
    const { request } = setup(() => ({ data: null, error: { code: "42501", message: "x" } }), { user: true, feedRow: null });
    expect((await request(`/feeds/${FEED_ID}/share`)).status).toBe(404);
  });

  it("the flyer has the name, the QR code and print instructions", async () => {
    const { request } = setup(kitRpc, { user: true, feedRow: { id: FEED_ID, name: "Room 12", slug: "room-12", visibility: "public" } });
    const body = await (await request(`/feeds/${FEED_ID}/flyer`)).text();
    expect(body).toContain("Room 12");
    expect(body).toMatch(/<svg[^>]*>/);
    expect(body).toContain("Point your phone");
    expect(body).toContain("data-print");
  });
});
