// Phase 12 routes (D33): subscribers' "Report a problem", one-click unsubscribe, notification
// settings, and the milestone thank-you card.
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv } from "./types.js";
import { formatWhen } from "./subscribe-views.js";
import { layout, messagePage, publicLayout } from "./views.js";

const Uid = z.string().regex(/^[0-9a-f-]{36}@feedcal\.app$/);
const Kind = z.enum(["wrong_details", "missing_event", "spam", "abuse", "other"]);
const KINDS: Record<z.infer<typeof Kind>, string> = {
  wrong_details: "The date, time or place is wrong",
  missing_event: "An event is missing",
  spam: "This looks like spam",
  abuse: "Something here is inappropriate",
  other: "Something else",
};
const UnsubKind = z.enum(["weekly_digest", "report", "stale_nudge", "milestone", "supporter_thanks", "events_published", "all"]);
const UNSUB_LABELS: Record<z.infer<typeof UnsubKind>, string> = {
  weekly_digest: "the weekly summary", report: "instant report notices", stale_nudge: "reminders about quiet calendars", milestone: "milestone thank-yous", events_published: "notices when Bumpdraft changes a calendar by itself", supporter_thanks: "supporter thank-yous (sent only once)", all: "all Bumpdraft emails",
};

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function reportPage(csrf: string, uid: string, error?: string) {
  return publicLayout("Report a problem", html`<div class="card">
  <h1>Report a problem</h1>
  <p>Tell the person who runs this calendar what's wrong. They'll get your note right away. We don't ask for your name or email.</p>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
  <form method="post" action="/report/${uid}">
    <input type="hidden" name="csrf" value="${csrf}">
    <fieldset style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;margin-bottom:.5rem">What's wrong?</legend>
      ${Object.entries(KINDS).map(([k, v], i) => html`<label class="check"><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""}> ${v}</label>`)}
    </fieldset>
    <p><label for="details">Details (optional)</label><textarea id="details" name="details" rows="3" maxlength="2000" dir="auto" placeholder="For example: it's at 9:30, not 8:30"></textarea></p>
    <button type="submit">Send report</button>
  </form>
</div>`);
}

// D88: "Ask the organizer". What public.event_questions_page() returns.
const QuestionsPage = z.object({
  event: z.object({ title: z.string().nullable(), calendar: z.string().nullable(), starts_at: z.string(), ends_at: z.string().nullable(), all_day: z.boolean(), timezone: z.string() }),
  answered: z.array(z.object({ question: z.string(), answer: z.string(), answered_at: z.string() })).max(50),
});
type QuestionsPage = z.infer<typeof QuestionsPage>;

export function askPage(csrf: string, uid: string, p: QuestionsPage, error?: string) {
  const title = p.event.title ?? "An event on a private calendar";
  return publicLayout(`Ask about ${title}`, html`<div class="card">
  <p class="muted">Ask the organizer</p>
  <h1 dir="auto">${title}</h1>
  <p><strong>${formatWhen(p.event)}</strong>${p.event.calendar ? html` · <span dir="auto">${p.event.calendar}</span>` : ""}</p>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
  <form method="post" action="/ask/${uid}">
    <input type="hidden" name="csrf" value="${csrf}">
    <p><label for="question">Your question</label><textarea id="question" name="question" rows="3" maxlength="500" required dir="auto" placeholder="For example: should we bring a packed lunch?"></textarea></p>
    <button type="submit">Send to the organizer</button>
  </form>
  <p class="muted">Only the person who runs this calendar sees your question. We don't ask for your name or email. If they answer, the question and the answer appear here for everyone, so don't include anything private.</p>
</div>
<div class="card">
  <h2>Answered</h2>
  ${p.answered.length === 0
    ? html`<p class="muted">No answers yet.</p>`
    : html`<dl class="qa">${p.answered.map((a) => html`<dt dir="auto">${a.question}</dt><dd dir="auto">${a.answer}</dd>`)}</dl>`}
</div>`);
}

export function registerNotifyRoutes(app: Hono<AppEnv>): void {
  // D88: every event links here ("Ask the organizer" in its description).
  const loadQuestions = async (c: Context<AppEnv>, uid: string): Promise<QuestionsPage | null> => {
    const { data, error } = await c.get("supabase").rpc("event_questions_page", { p_event_uid: uid });
    if (error) throw new Error("event_questions_page failed");
    const parsed = QuestionsPage.safeParse(data);
    return parsed.success ? parsed.data : null;
  };
  const noEvent = (c: Context<AppEnv>) => c.html(messagePage("Event not found", "This event isn't in the calendar any more, or the link isn't complete. Please open it again from the event in your calendar."), 404);
  app.get("/ask/:uid", async (c) => {
    c.header("x-robots-tag", "noindex");
    // Not "no-referrer": with it the browser sends "Origin: null" on this page's own form, and
    // the same-site check then refuses the question. "same-origin" tells other sites nothing.
    c.header("referrer-policy", "same-origin");
    const uid = Uid.safeParse(c.req.param("uid"));
    if (!uid.success) return noEvent(c);
    const page = await loadQuestions(c, uid.data);
    return page ? c.html(askPage(csrfToken(c), uid.data, page)) : noEvent(c);
  });
  app.post("/ask/:uid", async (c) => {
    c.header("x-robots-tag", "noindex");
    const uid = Uid.safeParse(c.req.param("uid"));
    if (!uid.success) return noEvent(c);
    const page = await loadQuestions(c, uid.data);
    if (!page) return noEvent(c);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(askPage(csrfToken(c), uid.data, page, MESSAGES.badForm), 403);
    const question = (body.question ?? "").trim().slice(0, 500);
    if (!question) return c.html(askPage(csrfToken(c), uid.data, page, "Please type your question."), 400);
    const ip = c.req.header("cf-connecting-ip");
    const { data, error } = await c.get("supabase").rpc("ask_question", { p_event_uid: uid.data, p_body: question, ...(ip ? { p_client_ip: ip } : {}) });
    if (error) throw new Error("ask_question failed");
    if (data === "rate_limited") return c.html(messagePage("Please wait", "Too many questions were sent from here recently. Please try again in an hour."), 429);
    if (data === "full") return c.html(messagePage("Please wait", "This event already has a lot of questions waiting for the organizer. Please check back later."), 429);
    if (data !== "ok") return noEvent(c);
    c.get("log").info("question_asked");
    return c.html(messagePage("Sent", "Your question went to the person who runs this calendar. If they answer, it will appear on this event's question page.", { href: `/ask/${uid.data}`, text: "Back to the event's questions" }));
  });


  // Every event in every calendar links here (the "Report a problem" line in its description).
  app.get("/report/:uid", (c) => {
    const uid = Uid.safeParse(c.req.param("uid"));
    if (!uid.success) return c.html(messagePage("Report a problem", "That link isn't complete. Please open it again from the event in your calendar."), 404);
    c.header("x-robots-tag", "noindex");
    return c.html(reportPage(csrfToken(c), uid.data));
  });

  app.post("/report/:uid", async (c) => {
    const uid = Uid.safeParse(c.req.param("uid"));
    if (!uid.success) return c.html(messagePage("Report a problem", "That link isn't complete."), 404);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(reportPage(csrfToken(c), uid.data, MESSAGES.badForm), 403);
    const kind = Kind.safeParse(body.kind);
    if (!kind.success) return c.html(reportPage(csrfToken(c), uid.data, "Please choose what's wrong."), 400);
    const ip = c.req.header("cf-connecting-ip");
    const { data, error } = await c.get("supabase").rpc("submit_report", {
      p_event_uid: uid.data, p_kind: kind.data, ...(body.details ? { p_details: body.details.slice(0, 2000) } : {}), ...(ip ? { p_client_ip: ip } : {}),
    });
    if (error) throw new Error("submit_report failed");
    if (data === "rate_limited") return c.html(messagePage("Please wait", "Too many reports were sent from here recently. Please try again in an hour."), 429);
    if (data === "not_found") return c.html(messagePage("Event not found", "This event isn't in the calendar any more, so there's nothing to report."), 404);
    c.get("log").info("report_submitted", { kind: kind.data });
    return c.html(messagePage("Thank you", "Your report was sent to the person who runs this calendar."));
  });

  // Unsubscribe from an email link. GET shows a button (link scanners can't unsubscribe you);
  // POST does it, and also serves mail apps' RFC 8058 one-click POST, which carries no Origin
  // header and no CSRF cookie: the signed token in the URL is the authorisation (D33).
  const UnsubQuery = z.object({ u: z.uuid(), k: UnsubKind, t: z.string().regex(/^[0-9a-f]{64}$/) });
  app.get("/unsubscribe", (c) => {
    const q = UnsubQuery.safeParse(c.req.query());
    if (!q.success) return c.html(messagePage("Link not valid", "This unsubscribe link isn't complete. You can change emails on your account page.", { href: "/account", text: "Account" }), 400);
    return c.html(publicLayout("Unsubscribe", html`<div class="card"><h1>Stop ${UNSUB_LABELS[q.data.k]}?</h1>
      <form method="post" action="/unsubscribe?u=${q.data.u}&amp;k=${q.data.k}&amp;t=${q.data.t}"><button type="submit">Yes, stop them</button></form>
      <p class="muted">You can turn them back on from your account page.</p></div>`));
  });
  app.post("/unsubscribe", async (c) => {
    const q = UnsubQuery.safeParse(c.req.query());
    if (!q.success) return c.html(messagePage("Link not valid", "This unsubscribe link isn't complete."), 400);
    const { data } = await c.get("supabase").rpc("unsubscribe", { p_user: q.data.u, p_kind: q.data.k, p_token: q.data.t });
    if (data !== true) return c.html(messagePage("Link not valid", "This unsubscribe link isn't valid. You can change emails on your account page.", { href: "/account", text: "Account" }), 400);
    c.get("log").info("unsubscribed", { kind: q.data.k });
    return c.html(messagePage("Done", `You won't get ${UNSUB_LABELS[q.data.k]} any more.`, { href: "/account", text: "Email settings" }));
  });

  app.post("/account/notifications", async (c) => {
    const user = await currentUser(c);
    if (!user) return c.redirect("/login", 303);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/account", text: "Back" }), 403);
    const values = {
      user_id: user.id, weekly_digest: body.weekly_digest === "1", instant_reports: body.instant_reports === "1",
      staleness: body.staleness === "1", milestones: body.milestones === "1", published_events: body.published_events === "1", updated_at: new Date().toISOString(),
    };
    const { error } = await c.get("supabase").from("notification_settings").upsert(values as never, { onConflict: "user_id" });
    if (error) throw new Error("notification_settings failed");
    return c.redirect("/account?done=notifications", 303);
  });

  // A thank-you card to share when a calendar reaches 10, 50 or 100 followers. No streaks.
  app.get("/feeds/:id/milestones/:n", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const n = z.coerce.number().int().refine((x) => [10, 50, 100].includes(x)).safeParse(c.req.param("n"));
    if (!id.success || !n.success) return c.html(messagePage("Not found", "That doesn't exist."), 404);
    const user = await currentUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/milestones/${n.data}`)}`, 303);
    const sb = c.get("supabase");
    const [{ data: feed }, { data: m }] = await Promise.all([
      sb.from("feeds").select("name").eq("id", id.data).maybeSingle(),
      sb.from("feed_milestones").select("reached_at").eq("feed_id", id.data).eq("milestone", n.data).maybeSingle(),
    ]);
    if (!feed || !m) return c.html(messagePage("Not yet", "This calendar hasn't reached that milestone yet."), 404);
    return c.html(layout(`${n.data} calendars`, html`<div class="card" style="text-align:center;padding:2.5rem 1.5rem;border:3px solid #c2410c">
      <p class="muted">Thank you</p>
      <h1 style="font-size:3rem;margin:.25rem 0">${n.data}</h1>
      <p style="font-size:1.25rem">calendars follow <strong dir="auto">${feed.name}</strong></p>
      <p class="muted">That's ${n.data} families who don't copy dates by hand. Thanks for keeping it up to date.</p>
    </div><p class="no-print"><a href="/feeds/${id.data}">Back to the calendar</a> · Take a screenshot or print this page to share it.</p>`));
  });
}
