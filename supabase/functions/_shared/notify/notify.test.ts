import { assert, assertEquals } from "jsr:@std/assert@1";
import { render } from "./templates.ts";
import { mailpit, resend } from "./sender.ts";

const SITE = "https://feedcal.example";
const UNSUB = "https://feedcal.example/unsubscribe?u=1&k=report&t=abc";

Deno.test("report email: says what and where, escapes the subscriber's text, has unsubscribe", () => {
  const r = render("report", { feed_id: "f", feed_name: "Room 12", event_id: "e", event_title: "Picture day", starts_at: "2026-11-21T16:30:00Z", all_day: false,
    timezone: "America/Los_Angeles", kind: "wrong_details", details: "<b>It's at 9</b>" }, SITE, UNSUB);
  assertEquals(r.subject, 'Someone reported a problem with "Picture day"');
  assert(r.text.includes("A subscriber to Room 12 says the details are wrong"));
  assert(r.text.includes("Sat, Nov 21, 8:30 AM")); // Nov 21, 2026 is a Saturday
  assert(r.html.includes("&lt;b&gt;It's at 9&lt;/b&gt;") && !r.html.includes("<b>It's"));
  assert(r.text.includes(`Stop these emails: ${UNSUB}`) && r.html.includes("Stop these emails"));
});

Deno.test("weekly digest: trends, review count in the subject, the 'at least' explanation", () => {
  const r = render("weekly_digest", { feeds: [{ id: "f1", name: "Room 12", subscribers: 14, subscribers_last_week: 9, taps: 3, events_added: 4, needs_review: 2, reports: 0 }] }, SITE, UNSUB);
  assertEquals(r.subject, "Your Feedcal week: 2 to review");
  assert(r.text.includes("At least 14 calendars follow it (up from 9); 3 subscribe taps this week."));
  assert(r.text.includes("4 events added. 2 to review. 0 reports."));
  assert(r.text.includes("calendar servers like Google check once"));
});

Deno.test("stale nudge and milestone wording", () => {
  assertEquals(render("stale_nudge", { feed_id: "f", feed_name: "Hawks", days: 46 }, SITE, UNSUB).subject, "Hawks hasn't had an update in 46 days");
  const m = render("milestone", { feed_id: "f", feed_name: "Hawks", milestone: 50 }, SITE, UNSUB);
  assertEquals(m.subject, "50 calendars follow Hawks");
  assert(m.text.includes(`${SITE}/feeds/f/milestones/50`));
});

Deno.test("senders call the right APIs", async () => {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fake = ((url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return Promise.resolve(new Response(JSON.stringify({ id: "r1", ID: "m1" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const msg = { to: "o@x.test", from: "Feedcal <hello@feedcal.test>", subject: "s", text: "t", html: "h", headers: { "List-Unsubscribe": "<u>" }, idempotencyKey: "k1" };
  assertEquals(await resend("re_test", fake).send(msg), { ok: true, id: "r1" });
  assertEquals(calls[0]?.url, "https://api.resend.com/emails");
  assertEquals(calls[0]?.headers.get("authorization"), "Bearer re_test");
  assertEquals(await mailpit("http://mail:8025/", fake).send(msg), { ok: true, id: "m1" });
  assertEquals(calls[1]?.url, "http://mail:8025/api/v1/send");
  assertEquals((calls[1]?.body as { From: { Email: string } }).From.Email, "hello@feedcal.test");
});
