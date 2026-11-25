// Phase 11 pages: dashboard, new feed, feed home with the review queue, event editor, settings.
// Mobile-first: one column, big buttons, plain words.
import { html } from "hono/html";
import { dayParts, formatWhen } from "./subscribe-views.js";
import { feedNav } from "./nav.js";
import { visibilityChoice, visibilityLabel } from "./visibility.js";
import { importStatus, type ImportStatus } from "./imports.js";
import { layout } from "./views.js";

type Html = ReturnType<typeof layout>;

export const CATEGORIES = ["school", "youth sports", "community", "faith", "library", "government", "venue/music", "other"] as const;
export const REJECT_REASONS: Record<string, string> = {
  not_an_event: "Not an event",
  wrong_date: "Wrong date",
  wrong_time: "Wrong time",
  wrong_details: "Wrong title or place",
  duplicate: "Already on the calendar",
  other: "Something else",
};
const REVIEW_LABELS: Record<string, string> = {
  low_confidence: "Calantern isn't sure about this one.",
  from_transcription: "Read from an image; compare with the picture.",
  possible_injection: "This email contains text aimed at the AI. Check it carefully before approving.",
  ambiguous_date: "The email's wording fits more than one date (like \"this Friday\" sent on a Friday). Check the date.",
  date_mismatch: "The date doesn't match what the email says. Check the date.",
  weekday_mismatch: "The weekday and the date in the email don't agree. Check which one is right.",
  time_mismatch: "The time doesn't match the time written in the email.",
  time_unlikely: "The email gives the time with no AM or PM, and this reading is the less usual one. Check the time.",
  before_email: "This date is before the email was sent. It may be a recap, or a misread.",
};

export const DONE: Record<string, string> = {
  approved: "Approved. It's on the calendar.",
  answered: "Answered. Followers can see it on the event's question page.",
  question_hidden: "Hidden. Nobody will see that question.",
  added_all: "Added. They're on the calendar.",
  rejected: "Rejected.",
  published: "Published.",
  discarded: "Draft discarded.",
  sure: "Approved everything marked Sure.",
  saved: "Saved. Subscribers' calendars will update.",
  cancelled: "Event cancelled. Calendars will remove it.",
  settings: "Settings saved.",
  editor_added: "Editor added.",
  editor_not_found: "No Calantern account uses that email yet. Ask them to sign in once, then add them again.",
  editor_removed: "Editor removed.",
  rule_cleared: "Attachment rule cleared.",
  sender: "Sender updated.",
  deleted: "Calendar deleted.",
  undone: "Undone.",
  too_late: "Too late to undo (10 seconds have passed).",
};

const csrf = (t: string) => html`<input type="hidden" name="csrf" value="${t}">`;

function banner(done: string | undefined, undo: { id: string; back: string } | null, token: string) {
  if (!done || !(done in DONE)) return "";
  return html`<div class="card" role="status"><p>${DONE[done]}</p>
  ${undo
    ? html`<form method="post" action="/undo/${undo.id}" id="undo-form" data-countdown="10">${csrf(token)}<input type="hidden" name="back" value="${undo.back}">
    <button type="submit" class="secondary">Undo <span id="undo-left" data-countdown-left>(10)</span></button></form>`
    : ""}</div>`;
}


// ---------------------------------------------------------------- dashboard
export interface DashboardFeed { id: string; name: string; visibility: string; lastUpdated: string; reviewCount: number; subscribers: number | null }

export function dashboardPage(opts: { csrf: string; feeds: DashboardFeed[]; done?: string | undefined; undo?: { id: string; back: string } | null | undefined }): Html {
  return layout("Your calendars", html`${banner(opts.done, opts.undo ?? null, opts.csrf)}
<div class="card">
  <h1>Your calendars</h1>
  ${opts.feeds.length === 0
    ? html`<p>You don't have a calendar yet. Make one for each group families follow, like "Room 12" or "U10 Hawks".</p>`
    : html`<ul class="events">${opts.feeds.map((f) => html`<li>
      <a href="/feeds/${f.id}"><strong dir="auto">${f.name}</strong></a>
      ${f.reviewCount > 0 ? html` <span class="badge">${f.reviewCount} to review</span>` : ""}
      <span class="when">${f.subscribers === null ? "" : `≈ ${f.subscribers} ${f.subscribers === 1 ? "calendar follows" : "calendars follow"} · `}updated ${new Date(f.lastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${visibilityLabel(f.visibility)}</span>
    </li>`)}</ul>`}
  <p><a class="button" href="/feeds/new">New calendar</a></p>
  <p><a href="/account">Your account</a></p>
</div>`);
}

export function newFeedPage(opts: { csrf: string; error?: string; values?: Record<string, string> }): Html {
  const v = opts.values ?? {};
  return layout("New calendar", html`<div class="card">
  <h1>New calendar</h1>
  <p class="muted">Give it a name. Next you'll connect where its emails come from.</p>
  ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
  <form method="post" action="/feeds/new">${csrf(opts.csrf)}
    <p><label for="name">Name</label><input class="copy" id="name" name="name" required maxlength="120" autocomplete="off" value="${v.name ?? ""}" placeholder="Room 12 families" dir="auto"></p>
    <details class="more"><summary>More options</summary>
      <p><label for="category">Kind</label><select class="copy" id="category" name="category">${CATEGORIES.map((c) => html`<option value="${c}" ${(v.category ?? "other") === c ? "selected" : ""}>${c}</option>`)}</select></p>
      <p class="muted" style="font-size:.875rem">It starts Private: only people with its link or QR code can see it. You can make it Public later in Settings.</p>
    </details>
    <button type="submit" class="wide">Next</button>
  </form>
</div>`);
}

// ---------------------------------------------------------------- feed home: review queue
export interface ReviewCard {
  id: string;
  /** The email it came from, when known: the page groups by it (D81). */
  messageId?: string | null;
  fromPicture?: boolean;
  title: string;
  when: { starts_at: string; all_day: boolean; timezone: string };
  location: string | null;
  confidence: number;
  outcome: string | null;
  changeKind: string;
  reviewReasons: string[];
  existing: { title: string; starts_at: string; all_day: boolean; timezone: string } | null;
  evidence: { before: string; quote: string; after: string; where: string };
  imageUrl: string | null;
  originalUrl: string | null;
  date: string;
  time: string;
}
type When = { starts_at: string; ends_at?: string | null; all_day: boolean; timezone: string };
export interface DraftCard {
  id: string; messageId?: string | null; title: string; when: When; location: string | null; confidence: number | null; quote: string | null;
  reviewReasons?: string[]; fromPicture?: boolean;
}
/** D88: an anonymous question about an event, waiting for the organizer. */
export interface QuestionRow { id: string; body: string; asked: string; eventId: string; eventTitle: string; when: When }
export interface EventRow { id: string; title: string; when: When; location: string | null; status: string }
/** One email and what its latest read did (D81). */
export interface EmailGroup {
  id: string; subject: string; sender: string | null; received: string;
  added: EventRow[];
  leftOut: { named: { title: string; when: string; why: string }[]; others: number };
}

/** "Thu, Nov 26 to Fri, Nov 27 · All day" when an event runs past its first day; else the usual form. */
export function whenRange(w: When): string {
  const first = formatWhen(w);
  if (!w.ends_at) return first;
  const day = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: w.timezone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  const [a, b] = [day(w.starts_at), day(w.ends_at)];
  return a === b ? first : first.replace(a, `${a} to ${b}`);
}

/** D85: the bars an event must clear to go on a calendar by itself. A calendar's own setting replaces the first. */
export const STANDARD_BAR = 0.45;
export const PICTURE_BAR = 0.45;

/** D81: one plain sentence on why something is waiting for the owner. */
export function whyWaiting(i: { reviewReasons?: string[]; fromPicture?: boolean; confidence: number | null; outcome?: string | null }, bar: number): string {
  const reason = (i.reviewReasons ?? []).find((r) => r !== "low_confidence" || (i.reviewReasons ?? []).length === 1);
  const label = reason && reason !== "low_confidence" ? REVIEW_LABELS[reason] : undefined;
  if (label) return label;
  if (i.outcome === "conflict") return "Calantern read this email again and got a different time from the one on your calendar.";
  if (i.outcome === "update" || i.outcome === "cancel" || i.outcome === "exdate") return "It changes something already on your calendar, and Calantern wasn't sure enough to do that by itself.";
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (i.confidence === null) return "Calantern wasn't sure enough to add this by itself.";
  const need = i.fromPicture ? Math.max(bar, PICTURE_BAR) : bar;
  if (i.confidence >= need) return `Calantern is ${pct(i.confidence)} sure, but held this back to be safe.`;
  return i.fromPicture
    ? `This was read from a picture, and Calantern was ${pct(i.confidence)} sure. Pictures need ${pct(need)} to go on by themselves.`
    : `Calantern was ${pct(i.confidence)} sure. It needs ${pct(need)} to add something by itself.`;
}

export const isSure = (c: { confidence: number; reviewReasons: string[]; outcome: string | null }) =>
  c.confidence >= 0.85 && c.reviewReasons.length === 0 && c.outcome !== "conflict";

function what(c: ReviewCard) {
  if (c.outcome === "update" || c.outcome === "conflict") {
    return html`<p><strong>${c.outcome === "conflict" ? "Different time?" : "Change"}</strong>: ${c.existing ? formatWhen(c.existing) : "?"} → <strong>${formatWhen(c.when)}</strong></p>`;
  }
  if (c.changeKind === "cancelled") return html`<p><strong>Cancel</strong>${c.outcome === "exdate" ? " this one date" : ""}: ${formatWhen(c.when)}</p>`;
  return html`<p><strong>New</strong>: ${formatWhen(c.when)}${c.location ? html` · <span dir="auto">${c.location}</span>` : ""}</p>`;
}

export function feedHomePage(opts: {
  csrf: string; feedId: string; name: string; cards: ReviewCard[]; drafts: DraftCard[]; upcoming: EventRow[];
  /** D81: the emails things came from. Without it, everything waiting is shown in one group. */
  emails?: EmailGroup[]; bar?: number;
  /** D88: followers' questions that have no answer yet. */
  questions?: QuestionRow[];
  done?: string | undefined; undo?: { id: string; back: string } | null | undefined;
}): Html {
  const t = opts.csrf;
  const bar = opts.bar ?? STANDARD_BAR;
  const questions = opts.questions ?? [];
  const sure = opts.cards.filter(isSure).length + opts.drafts.filter((d) => (d.confidence ?? 0) >= 0.85 && (d.reviewReasons ?? []).length === 0).length;
  const waiting = opts.cards.length + opts.drafts.length;

  // One question: a change or new event Calantern wasn't sure enough to make itself.
  const ask = (c: ReviewCard) => html`<section class="part ask">
    <h3>Needs you</h3>
    <p class="q" dir="auto">${c.title}</p>
    ${what(c)}
    ${c.imageUrl ? html`<p><img src="${c.imageUrl}" alt="The page this came from" style="max-width:100%;border-radius:8px"></p>` : ""}
    <blockquote class="muted" dir="auto">…${c.evidence.before}<mark>${c.evidence.quote}</mark>${c.evidence.after}…<br><small>${c.evidence.where}</small></blockquote>
    ${c.originalUrl ? html`<p><a href="${c.originalUrl}" target="_blank" rel="noopener">Open the original file</a></p>` : ""}
    ${c.reviewReasons.includes("possible_injection") ? html`<p class="error">${REVIEW_LABELS.possible_injection}</p>` : html`<p class="why">Why it's waiting: ${whyWaiting(c, bar)}</p>`}
    <div class="row">
      <form method="post" action="/feeds/${opts.feedId}/candidates/${c.id}/approve">${csrf(t)}<button type="submit">${c.changeKind === "cancelled" ? "Yes, cancel it" : c.outcome === "update" || c.outcome === "conflict" ? "Yes, change it" : "Yes, add it"}</button></form>
    </div>
    <details><summary>Fix it</summary>
      <form method="post" action="/feeds/${opts.feedId}/candidates/${c.id}/approve">${csrf(t)}
        <p><label for="t-${c.id}">Title</label><input class="copy" id="t-${c.id}" name="title" value="${c.title}" dir="auto"></p>
        <p><label for="d-${c.id}">Date</label><input class="copy" type="date" id="d-${c.id}" name="date" value="${c.date}"></p>
        ${c.when.all_day ? "" : html`<p><label for="h-${c.id}">Time</label><input class="copy" type="time" id="h-${c.id}" name="time" value="${c.time}"></p>`}
        <p><label for="l-${c.id}">Place</label><input class="copy" id="l-${c.id}" name="location" value="${c.location ?? ""}" dir="auto"></p>
        <button type="submit" class="secondary">Save and add</button>
      </form>
    </details>
    <details><summary>Not right</summary>
      <form method="post" action="/feeds/${opts.feedId}/candidates/${c.id}/reject">${csrf(t)}
        <p><label for="r-${c.id}">Why?</label><select class="copy" id="r-${c.id}" name="reason">${Object.entries(REJECT_REASONS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></p>
        <p><label for="n-${c.id}">Note (optional, helps Calantern learn)</label><input class="copy" id="n-${c.id}" name="note" maxlength="500"></p>
        <button type="submit" class="danger">Leave it out</button>
      </form>
    </details>
  </section>`;
  // One question: an event Calantern found but did not put on the calendar.
  const askDraft = (d: DraftCard) => html`<section class="part ask">
    <h3>Needs you</h3>
    <p class="q" dir="auto">${d.title}</p>
    <p class="qwhen"><strong>${whenRange(d.when).split(" · ")[0]}</strong> · ${whenRange(d.when).split(" · ").slice(1).join(" · ")}${d.location ? html` · <span dir="auto">${d.location}</span>` : ""}</p>
    ${d.quote ? html`<blockquote class="muted" dir="auto"><mark>${d.quote}</mark></blockquote>` : ""}
    <p class="why">Why it's waiting: ${whyWaiting(d, bar)}</p>
    <div class="row">
      <form method="post" action="/feeds/${opts.feedId}/drafts/${d.id}/publish">${csrf(t)}<button type="submit">Yes, add it</button></form>
      <a class="button secondary" href="/feeds/${opts.feedId}/events/${d.id}">Fix it</a>
      <form method="post" action="/feeds/${opts.feedId}/drafts/${d.id}/discard">${csrf(t)}<button type="submit" class="link">Not an event</button></form>
    </div>
  </section>`;
  const addedList = (rows: EventRow[]) => rows.length === 0 ? "" : html`<section class="part">
    <h3>Added to your calendar</h3>
    <ul class="rows">${rows.map((e) => html`<li><span class="tick" aria-hidden="true">✓</span><span class="t"><strong dir="auto">${e.title}</strong><span class="d">${whenRange(e.when)}</span></span><a href="/feeds/${opts.feedId}/events/${e.id}">Edit</a></li>`)}</ul>
  </section>`;
  const leftOut = (l: EmailGroup["leftOut"]) => {
    const n = l.named.length + l.others;
    if (n === 0) return "";
    return html`<details class="left"><summary>${n} left out</summary><ul>
      ${l.named.map((x) => html`<li><span dir="auto">${x.title}</span>, ${x.when}: ${x.why}</li>`)}
      ${l.others > 0 ? html`<li>${l.others} ${l.others === 1 ? "other" : "others"} that didn't pass Calantern's checks</li>` : ""}
    </ul></details>`;
  };
  const summary = (added: number, asks: number) => {
    const did = added > 0 ? html`<strong>added ${added} ${added === 1 ? "event" : "events"}</strong>` : "";
    const unsure = asks > 0 ? html`is <strong>unsure about ${asks}</strong>` : "";
    return added > 0 && asks > 0 ? html`Calantern ${did} and ${unsure}.` : asks > 0 ? html`Calantern ${unsure}.` : html`Calantern ${did}.`;
  };

  // D85: one button for an email with two or more new events waiting. Changes to events already on
  // the calendar, cancellations and anything flagged as aimed at the AI keep their own buttons.
  const addAll = (cards: ReviewCard[], drafts: DraftCard[]) => {
    const plain = cards.filter((c) => c.changeKind !== "cancelled" && !["update", "conflict", "cancel", "exdate"].includes(c.outcome ?? "") && !c.reviewReasons.includes("possible_injection"));
    const n = plain.length + drafts.length;
    if (n < 2) return "";
    return html`<form method="post" action="/feeds/${opts.feedId}/add-all" class="addall">${csrf(t)}
        <input type="hidden" name="candidates" value="${plain.map((c) => c.id).join(",")}"><input type="hidden" name="drafts" value="${drafts.map((d) => d.id).join(",")}">
        <button type="submit">Add all ${n}</button> <span class="muted">or go through them below</span></form>`;
  };

  // Group what is waiting under the email it came from. Anything with no known email goes last.
  const groups = (opts.emails ?? []).map((m) => ({ m, cards: opts.cards.filter((c) => c.messageId === m.id), drafts: opts.drafts.filter((d) => d.messageId === m.id) }));
  const known = new Set((opts.emails ?? []).map((m) => m.id));
  const loose = { cards: opts.cards.filter((c) => !c.messageId || !known.has(c.messageId)), drafts: opts.drafts.filter((d) => !d.messageId || !known.has(d.messageId)) };
  const busy = groups.filter((g) => g.cards.length + g.drafts.length > 0);
  const quiet = groups.filter((g) => g.cards.length + g.drafts.length === 0 && (g.m.added.length > 0 || g.m.leftOut.named.length + g.m.leftOut.others > 0)).slice(0, 5);
  const head = (m: EmailGroup) => html`<h2 dir="auto">${m.subject}</h2>
      <p class="from">${m.sender ? html`From <span dir="auto">${m.sender}</span> · ` : ""}${m.received}</p>`;
  const hasCards = busy.length + quiet.length > 0 || loose.cards.length + loose.drafts.length > 0;

  return layout(opts.name, html`${banner(opts.done, opts.undo ?? null, t)}
<div class="card">
  <h1 dir="auto">${opts.name}</h1>
  ${feedNav(opts.feedId, "home")}
  ${waiting === 0
    ? html`<p class="status muted">Nothing needs you. New emails are read within a few minutes of arriving.</p>`
    : html`<p class="status"><strong>${waiting} ${waiting === 1 ? "thing needs" : "things need"} you.</strong> Everything else Calantern found is on the calendar.</p>
  ${sure > 1 ? html`<form method="post" action="/feeds/${opts.feedId}/approve-sure">${csrf(t)}<button type="submit" class="secondary">Add the ${sure} Calantern is sure about</button></form>` : ""}`}
</div>
${questions.length > 0 ? html`<div class="card">
  <h2>${questions.length === 1 ? "A follower asked a question" : `Followers asked ${questions.length} questions`}</h2>
  <p class="muted">Only you can see these. When you answer one, the question and your answer show on that event's question page for all followers.</p>
  ${questions.map((q) => html`<section class="part ask">
    <p class="q" dir="auto">${q.body}</p>
    <p class="qwhen">About <a href="/feeds/${opts.feedId}/events/${q.eventId}"><strong dir="auto">${q.eventTitle}</strong></a> · ${formatWhen(q.when)} · asked ${q.asked}</p>
    <form method="post" action="/feeds/${opts.feedId}/questions/${q.id}/answer">${csrf(t)}
      <p><label for="a-${q.id}">Your answer</label><textarea id="a-${q.id}" name="answer" rows="2" maxlength="1000" required dir="auto"></textarea></p>
      <div class="row"><button type="submit">Answer for everyone</button></div>
    </form>
    <form method="post" action="/feeds/${opts.feedId}/questions/${q.id}/hide">${csrf(t)}<button type="submit" class="link">Hide this question</button></form>
  </section>`)}
</div>` : ""}
${hasCards ? html`<div class="split"><div>` : ""}
${busy.map((g) => html`<article class="mailcard">
    <header>${head(g.m)}
      <p class="sum">${summary(g.m.added.length, g.cards.length + g.drafts.length)}</p>
      ${addAll(g.cards, g.drafts)}
    </header>
    ${g.cards.map(ask)}${g.drafts.map(askDraft)}
    ${addedList(g.m.added)}
    ${leftOut(g.m.leftOut)}
  </article>`)}
${loose.cards.length + loose.drafts.length > 0 ? html`<article class="mailcard">
    <header><h2>Found earlier</h2><p class="sum">${summary(0, loose.cards.length + loose.drafts.length)}</p>${addAll(loose.cards, loose.drafts)}</header>
    ${loose.cards.map(ask)}${loose.drafts.map(askDraft)}
  </article>` : ""}
${quiet.map((g) => html`<details class="mailcard quiet">
    <summary><span class="s" dir="auto">${g.m.subject}</span><span class="from">${g.m.received} · ${g.m.added.length > 0 ? `added ${g.m.added.length}` : "nothing added"}</span></summary>
    ${addedList(g.m.added)}
    ${leftOut(g.m.leftOut)}
  </details>`)}
${hasCards ? html`</div><aside>` : ""}
<div class="card">
  <h2>Coming up</h2>
  ${opts.upcoming.length === 0
    ? html`<p class="muted">No upcoming events yet. <a href="/feeds/${opts.feedId}/events/new">Add one</a>, or forward an email.</p>`
    : html`<ul class="cal">${opts.upcoming.map((e, i) => {
        const d = dayParts(e.when);
        return html`<li class="${i === 0 ? "next" : ""}"><span class="day" aria-hidden="true"><span class="dow">${d.dow}</span><span class="num">${d.num}</span></span><span class="what"><a href="/feeds/${opts.feedId}/events/${e.id}"><strong dir="auto">${e.title}</strong></a><span class="when">${whenRange(e.when)}${e.location ? html` · <span dir="auto">${e.location}</span>` : ""}${e.status === "cancelled" ? " · Cancelled" : ""}</span></span></li>`;
      })}</ul>`}
</div>
${hasCards ? html`</aside></div>` : ""}`);
}

// ---------------------------------------------------------------- event editor
export interface Revision { at: string; cause: string; actor: string }
const CAUSES: Record<string, string> = { extracted: "Found in an email", matched_update: "Updated from an email", manual_edit: "Edited", cancelled: "Cancelled", restored: "Published" };

export function eventEditPage(opts: {
  csrf: string; feedId: string; eventId: string | null; error?: string; timezone: string;
  values: { title: string; date: string; time: string; end_date: string; end_time: string; all_day: boolean; location: string; description: string };
  status?: string; quote?: string | null; history: Revision[]; done?: string | undefined; undo?: { id: string; back: string } | null | undefined;
}): Html {
  const v = opts.values;
  const action = opts.eventId ? `/feeds/${opts.feedId}/events/${opts.eventId}` : `/feeds/${opts.feedId}/events`;
  return layout(opts.eventId ? "Edit event" : "Add event", html`${banner(opts.done, opts.undo ?? null, opts.csrf)}
<div class="card">
  <h1>${opts.eventId ? "Edit event" : "Add event"}</h1>
  ${feedNav(opts.feedId, "event")}
  ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
  ${opts.status === "cancelled" ? html`<p class="error" role="alert">This event is cancelled.</p>` : ""}
  <form method="post" action="${action}">${csrf(opts.csrf)}
    <p><label for="title">Title</label><input class="copy" id="title" name="title" required maxlength="300" value="${v.title}" dir="auto"></p>
    <p><label class="check"><input type="checkbox" name="all_day" value="1" ${v.all_day ? "checked" : ""}> All day</label></p>
    <p><label for="date">Date</label><input class="copy" type="date" id="date" name="date" required value="${v.date}"></p>
    <p><label for="time">Start time</label><input class="copy" type="time" id="time" name="time" value="${v.time}"></p>
    <p><label for="end_date">End date (optional)</label><input class="copy" type="date" id="end_date" name="end_date" value="${v.end_date}"></p>
    <p><label for="end_time">End time (optional)</label><input class="copy" type="time" id="end_time" name="end_time" value="${v.end_time}"></p>
    <p class="muted">Times are ${opts.timezone.replace(/_/g, " ")} time.</p>
    <p><label for="location">Place</label><input class="copy" id="location" name="location" maxlength="500" value="${v.location}" dir="auto"></p>
    <p><label for="description">Notes</label><textarea id="description" name="description" rows="3" maxlength="8000" dir="auto">${v.description}</textarea></p>
    <button type="submit">Save</button>
  </form>
  ${opts.eventId && opts.status !== "cancelled"
    ? html`<form method="post" action="/feeds/${opts.feedId}/events/${opts.eventId}/cancel">${csrf(opts.csrf)}<button type="submit" class="danger">Cancel this event</button></form>`
    : ""}
</div>
${opts.quote ? html`<div class="card"><h2>Where it came from</h2><blockquote class="muted" dir="auto"><mark>${opts.quote}</mark></blockquote></div>` : ""}
${opts.history.length
  ? html`<div class="card"><h2>History</h2><ul class="events">${opts.history.map((h) => html`<li>${CAUSES[h.cause] ?? h.cause}<span class="when">${new Date(h.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: opts.timezone })} · ${h.actor === "ai" ? "Calantern" : h.actor.startsWith("user:") ? "a person" : h.actor}</span></li>`)}</ul></div>`
  : ""}`);
}

// ---------------------------------------------------------------- settings
export interface SettingsData {
  name: string; description: string; visibility: string; timezone: string; threshold: number; isOwner: boolean;
  zip: string | null; zipSuggestion: { zip: string; places: number } | null;
  imported?: ImportStatus; importNotice?: string | null;
  editors: { userId: string; label: string; role: string }[];
  senders: { id: string; email: string; trusted: boolean; blocked: boolean; rule: string | null }[];
}

export function settingsPage(opts: { csrf: string; feedId: string; s: SettingsData; error?: string; done?: string | undefined; undo?: { id: string; back: string } | null | undefined }): Html {
  const s = opts.s;
  const t = opts.csrf;
  return layout("Settings", html`${banner(opts.done, opts.undo ?? null, t)}
<div class="card">
  <h1>Settings</h1>
  ${feedNav(opts.feedId, "settings")}
  ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
  ${s.isOwner
    ? html`<form method="post" action="/feeds/${opts.feedId}/settings">${csrf(t)}
    <p><label for="name">Name</label><input class="copy" id="name" name="name" required maxlength="120" autocomplete="off" value="${s.name}" dir="auto"></p>
    ${visibilityChoice(s.visibility, { zip: s.zip, suggestion: s.zipSuggestion })}
    <details class="more"><summary>More settings</summary>
    <p><label for="description">Description</label><textarea id="description" name="description" rows="2" maxlength="2000" dir="auto">${s.description}</textarea></p>
    <p><label for="timezone">Time zone</label><input class="copy" id="timezone" name="timezone" autocomplete="off" spellcheck="false" value="${s.timezone}" pattern="[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}"></p>
    <p><label for="threshold">Publish automatically when Calantern is at least this sure (from trusted senders)</label>
      <select class="copy" id="threshold" name="threshold">${[0.45, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1].map((n) => html`<option value="${n}" ${Math.abs(s.threshold - n) < 0.001 ? "selected" : ""}>${n === 1 ? "Never: I review everything" : `${Math.round(n * 100)}%`}</option>`)}</select></p>
    </details>
    <button type="submit">Save settings</button>
  </form>`
    : html`<p class="muted">Only the owner can change these settings.</p>`}
</div>
<details class="more card" ${s.importNotice ? "open" : ""}><summary>Senders, editors, imports and the subscribe link</summary>
${s.isOwner ? html`<div class="card">
  <h2>Copy events from a calendar link</h2>
  ${s.importNotice ? html`<p role="status">${s.importNotice}</p>` : ""}
  ${importStatus(opts.feedId, t, s.imported ?? null)}
</div>` : ""}
${s.isOwner ? html`<div class="card">
  <h2>Verified badge</h2>
  <p>Families trust calendars from verified organizers. We verify automatically when you sign in with your organisation's email and it sends this calendar's emails.</p>
  <form method="post" action="/feeds/${opts.feedId}/verify">${csrf(t)}<button type="submit" class="secondary">Check verification</button></form>
</div>` : ""}
<div class="card">
  <h2>Subscribe link</h2>
  <p><a href="/feeds/${opts.feedId}/share">See the subscribe link, QR code and flyer</a>. If the link reached the wrong people, you can make a new one there.</p>
</div>
<div class="card">
  <h2>Senders</h2>
  ${s.senders.length === 0 ? html`<p class="muted">No senders yet. They appear when you forward email.</p>` : html`<ul class="events">${s.senders.map((x) => html`<li>${x.email}
    <span class="when">${x.trusted ? "Trusted" : x.blocked ? "Ignored" : "Waiting for your OK"}${x.rule ? ` · ${x.rule}` : ""}</span>
    <div class="row" style="margin-top:.5rem">
      <form method="post" action="/feeds/${opts.feedId}/senders/${x.id}">${csrf(t)}<input type="hidden" name="decision" value="${x.trusted ? "no" : "yes"}"><input type="hidden" name="back" value="settings"><button type="submit" class="secondary">${x.trusted ? "Stop using" : "Trust"}</button></form>
      ${x.rule ? html`<form method="post" action="/feeds/${opts.feedId}/sources/${x.id}/clear-rule">${csrf(t)}<button type="submit" class="secondary">Forget attachment rule</button></form>` : ""}
    </div></li>`)}</ul>`}
</div>
<div class="card">
  <h2>Editors</h2>
  <ul class="events">${s.editors.map((e) => html`<li>${e.label} <span class="muted">(${e.role})</span>
    ${s.isOwner && e.role !== "owner" ? html`<form method="post" action="/feeds/${opts.feedId}/editors/${e.userId}/remove">${csrf(t)}<button type="submit" class="secondary">Remove</button></form>` : ""}</li>`)}</ul>
  ${s.isOwner ? html`<form method="post" action="/feeds/${opts.feedId}/editors">${csrf(t)}
    <p><label for="editor">Add an editor by email</label><input class="copy" type="email" id="editor" name="email" required maxlength="320" autocomplete="off" spellcheck="false"></p>
    <button type="submit" class="secondary">Add editor</button></form>` : ""}
</div>
</details>
${s.isOwner ? html`<div class="card">
  <h2>Delete this calendar</h2>
  <p>Subscribers stop getting updates at once. You'll have 10 seconds to undo.</p>
  <form method="post" action="/feeds/${opts.feedId}/delete">${csrf(t)}
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> Delete this calendar and all its events</label></p>
    <button type="submit" class="danger">Delete calendar</button></form>
</div>` : ""}`);
}
