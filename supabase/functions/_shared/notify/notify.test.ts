import { assert, assertEquals } from "jsr:@std/assert@1";
import { NO_UNSUBSCRIBE, render } from "./templates.ts";
import { mailpit, resend } from "./sender.ts";

const SITE = "https://feedcal.example";
const UNSUB = "https://feedcal.example/unsubscribe?u=1&k=report&t=abc";

Deno.test("report email: says what and where, escapes the subscriber's text, has unsubscribe", () => {
  const r = render("report", { feed_id: "f", feed_name: "Room 12", event_id: "e", event_title: "Picture day", starts_at: "2026-11-21T16:30:00Z", all_day: false,
    timezone: "America/Los_Angeles", kind: "wrong_details", details: "<b>It's at 9</b>" }, SITE, UNSUB);
  assertEquals(r.subject, 'Someone spotted a problem with "Picture day"');
  assert(r.text.includes("Someone following Room 12 says the details are wrong"));
  assert(r.text.includes("Sat, Nov 21, 8:30 AM")); // Nov 21, 2026 is a Saturday
  assert(r.html.includes("&lt;b&gt;It's at 9&lt;/b&gt;") && !r.html.includes("<b>It's"));
  assert(r.text.includes(`Stop these emails: ${UNSUB}`) && r.html.includes("Stop these emails"));
  // Every email also says how to stop following a calendar in the calendar app, with the steps page.
  assert(r.text.includes(`Unsubscribe from it in your calendar app. Steps for each app: ${SITE}/help/unsubscribe`));
  assert(r.html.includes(`<a href="${SITE}/help/unsubscribe">your calendar app</a>`));
  assert(r.text.startsWith("Hi,\n\n") && r.text.includes("Thanks,\nCalantern"));
});

Deno.test("weekly digest: what needs you first, the follower guess last and small", () => {
  const r = render("weekly_digest", { feeds: [{ id: "f1", name: "Room 12", subscribers: 14, subscribers_last_week: 9, taps: 3, events_added: 4, needs_review: 2, reports: 0 }] }, SITE, UNSUB);
  assertEquals(r.subject, "Your Calantern week: 2 to review");
  assert(r.text.includes("Here's your week. 2 events need a quick look from you."));
  assert(r.text.includes("2 events waiting for your OK.\n  4 new events this week.\n  Open it: https://feedcal.example/feeds/f1\n  Roughly 14 calendars follow it (a rough guess)."));
  assert(!r.text.includes("up from") && !r.text.includes("subscribe taps"), "no trend or tap counts");
  const quiet = render("weekly_digest", { feeds: [{ id: "f1", name: "Room 12", subscribers: 0, subscribers_last_week: 0, taps: 0, events_added: 1, needs_review: 0, reports: 1 }] }, SITE, UNSUB);
  assert(quiet.text.includes("Nothing waiting for you.\n  1 new event this week, 1 problem report.") && !quiet.text.includes("Roughly"));
});

Deno.test("stale nudge and milestone wording", () => {
  assertEquals(render("stale_nudge", { feed_id: "f", feed_name: "Hawks", days: 46 }, SITE, UNSUB).subject, "Hawks has been quiet for 46 days");
  const m = render("milestone", { feed_id: "f", feed_name: "Hawks", milestone: 50 }, SITE, UNSUB);
  assertEquals(m.subject, "Hawks is helping a lot of families");
  assert(m.text.includes("around 50 calendars follow it now. It's only a guess"));
  assert(m.text.includes(`${SITE}/feeds/f/milestones/50`));
});

Deno.test("senders call the right APIs", async () => {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fake = ((url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return Promise.resolve(new Response(JSON.stringify({ id: "r1", ID: "m1" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const msg = { to: "o@x.test", from: "Calantern <hello@feedcal.test>", subject: "s", text: "t", html: "h", headers: { "List-Unsubscribe": "<u>" }, idempotencyKey: "k1" };
  assertEquals(await resend("re_test", fake).send(msg), { ok: true, id: "r1" });
  assertEquals(calls[0]?.url, "https://api.resend.com/emails");
  assertEquals(calls[0]?.headers.get("authorization"), "Bearer re_test");
  assertEquals(await mailpit("http://mail:8025/", fake).send(msg), { ok: true, id: "m1" });
  assertEquals(calls[1]?.url, "http://mail:8025/api/v1/send");
  assertEquals((calls[1]?.body as { From: { Email: string } }).From.Email, "hello@feedcal.test");
});

Deno.test("ops alert email (D38): says what and where to look, marks drills, has no unsubscribe", () => {
  const real = render("ops_alert", { kind: "queue_backlog", detail: { queue: "extract_message", oldest_minutes: 22 }, drill: false }, "https://feedcal.test", "https://feedcal.test/unsubscribe?x");
  assert(real.subject.startsWith("Calantern alert: Emails are waiting"));
  assert(real.text.includes("extract_message") && real.text.includes("queue-backlog.md"));
  assert(!real.text.includes("unsubscribe") && !real.html.includes("unsubscribe"), "no unsubscribe link");
  const drill = render("ops_alert", { kind: "abuse_spike", detail: {}, drill: true }, "https://feedcal.test", "x");
  assert(drill.subject.startsWith("[Drill]") && drill.text.startsWith("This is a drill."));
  assert(NO_UNSUBSCRIBE.has("ops_alert") && !NO_UNSUBSCRIBE.has("report"));
});

Deno.test("gmail reconnect email (D39): names the feed, links to reconnect, no unsubscribe", () => {
  const soon = render("gmail_reconnect", { feed_id: "f1", feed_name: "Room F", expired: false }, "https://feedcal.test", "x");
  assert(soon.subject === "Reconnect Gmail for Room F by tomorrow");
  // The exact link, as its own word, not just somewhere in the text (D59).
  const links = soon.text.match(/https?:\/\/\S+/g) ?? [];
  assertEquals(links.filter((l) => l.includes("/gmail")), ["https://feedcal.test/feeds/f1/gmail"]);
  const gone = render("gmail_reconnect", { feed_id: "f1", feed_name: "Room F", expired: true }, "https://feedcal.test", "x");
  assert(gone.subject === "Reconnect Gmail for Room F" && gone.text.includes("won't reach the calendar"));
  // D86: the reminder sent every 20 days while it stays disconnected.
  const still = render("gmail_reconnect", { feed_id: "f1", feed_name: "Room F", expired: true, days_lapsed: 40 }, "https://feedcal.test", "x");
  assertEquals(still.subject, "Gmail for Room F has been disconnected for 40 days");
  assert(still.text.includes("tells its followers"));
  // The exact link, as its own word (D59).
  assertEquals((still.text.match(/https?:\/\/\S+/g) ?? []).filter((l) => l.includes("/gmail")), ["https://feedcal.test/feeds/f1/gmail"]);
  assert(NO_UNSUBSCRIBE.has("gmail_reconnect"));
});

Deno.test("subjects stay one line whatever the names and titles contain (D60)", () => {
  for (const bad of ["\r\nBcc: evil@example.test", "a\nb", "a\rb", "a\u2028b", "a\u0085b", "a\x00b", "a\tb"]) {
    for (const r of [
      render("report", { feed_id: "f", feed_name: bad, event_id: "e", event_title: bad, starts_at: "2026-11-21T16:30:00Z", all_day: false, timezone: "UTC", kind: "other", details: "" }, SITE, UNSUB),
      render("stale_nudge", { feed_id: "f", feed_name: bad, days: 46 }, SITE, UNSUB),
      render("milestone", { feed_id: "f", feed_name: bad, milestone: 50 }, SITE, UNSUB),
      render("gmail_reconnect", { feed_id: "f", feed_name: bad, expired: true }, SITE, UNSUB),
    ]) assert(!/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(r.subject), JSON.stringify(r.subject));
  }
});

Deno.test("contact message email (D63): escaped, one-line subject, safe Reply-To, no unsubscribe", () => {
  const r = render("contact", { kind: "bug", message: "<img src=x onerror=alert(1)>\r\nBcc: evil@example.test\nThe flyer is blank", reply_to: "parent@example.test", page: "/feeds/x/flyer", signed_in: false }, SITE, UNSUB);
  assert(!r.html.includes("<img src=x") && r.html.includes("&lt;img src=x"), "message is escaped");
  assert(!/[\r\n]/.test(r.subject) && r.subject.startsWith("Calantern bug report:"), r.subject);
  assertEquals(r.replyTo, "parent@example.test");
  assert(r.text.includes("Reply to: parent@example.test") && r.text.includes("Page: /feeds/x/flyer"));
  assert(NO_UNSUBSCRIBE.has("contact") && !r.text.includes("Stop these emails"));
  for (const bad of ["a@b.co\r\nBcc: x@y.z", "<a@b.co>", "a@b", "a,b@c.co", "x".repeat(300) + "@a.co", 42, null]) {
    assertEquals(render("contact", { kind: "other", message: "hi", reply_to: bad }, SITE, UNSUB).replyTo, undefined, JSON.stringify(bad));
  }
});

Deno.test("backup alarm email (D65) names the problem and where to look", () => {
  const r = render("ops_alert", { kind: "backup_stale", detail: { last_backup: "2026-11-21T22:57:27Z", hours: 31 }, drill: false }, SITE, UNSUB);
  assertEquals(r.subject, "Calantern alert: No database backup in over 30 hours");
  assert(r.text.includes("restore.md") && r.text.includes("\"hours\":31"));
});

Deno.test("D77: the auto-publish email lists each change with the words it was read from and a way to fix it", () => {
  const r = render("events_published", { feed_id: "f1", feed_name: "Room F", subject: "TGIF", items: [
    { event_id: "e1", title: "Share Day <b>", starts_at: "2026-11-25T20:00:00Z", all_day: true, timezone: "America/Los_Angeles", quote: "we will share on Wednesday", what: "added", picture: true },
    { event_id: "e2", title: "Musical", starts_at: "2026-12-19T02:00:00Z", all_day: false, timezone: "America/Los_Angeles", quote: "Dec 18 at 6 PM", what: "changed", picture: false },
  ] }, SITE, UNSUB);
  assertEquals(r.subject, 'Room F: 2 calendar changes from "TGIF"');
  assert(r.text.includes("without asking you"));
  assert(r.text.includes('Added: Share Day <b>') && r.text.includes('Read from a picture: "we will share on Wednesday"'));
  assert(r.text.includes("Changed: Musical") && r.text.includes(`Fix or remove: ${SITE}/feeds/f1/events/e2`));
  assert(r.html.includes("Share Day &lt;b&gt;") && !r.html.includes("Share Day <b>"), "titles from emails are escaped");
  assert(r.text.includes(UNSUB), "it can be switched off");
  const one = render("events_published", { feed_id: "f1", feed_name: "Room F", subject: "TGIF\r\nBcc: x@y.z", items: [
    { event_id: "e1", title: "Picture day", starts_at: "2026-11-25T20:00:00Z", all_day: true, timezone: "America/Los_Angeles", quote: "q", what: "cancelled" }] }, SITE, UNSUB);
  assertEquals(one.subject, 'Room F: cancelled "Picture day" from "TGIF Bcc: x@y.z"', "one line, whatever the email's subject held");
});
