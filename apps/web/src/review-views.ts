// Phase 11 pages: dashboard, new feed, feed home with the review queue, event editor, settings.
// Mobile-first: one column, big buttons, plain words.
import { html } from "hono/html";
import { formatWhen } from "./subscribe-views.js";
import { feedNav } from "./nav.js";
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
  low_confidence: "Feedcal isn't sure about this one.",
  from_transcription: "Read from an image; compare with the picture.",
  possible_injection: "This email contains text aimed at the AI. Check it carefully before approving.",
};

export const DONE: Record<string, string> = {
  approved: "Approved. It's on the calendar.",
  rejected: "Rejected.",
  published: "Published.",
  discarded: "Draft discarded.",
  sure: "Approved everything marked Sure.",
  saved: "Saved. Subscribers' calendars will update.",
  cancelled: "Event cancelled. Calendars will remove it.",
  settings: "Settings saved.",
  editor_added: "Editor added.",
  editor_not_found: "No Feedcal account uses that email yet. Ask them to sign in once, then add them again.",
  editor_removed: "Editor removed.",
  rule_cleared: "Attachment rule cleared.",
  sender: "Sender updated.",
  deleted: "Feed deleted.",
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
  return layout("Your feeds", html`${banner(opts.done, opts.undo ?? null, opts.csrf)}
<div class="card">
  <h1>Your feeds</h1>
  ${opts.feeds.length === 0
    ? html`<p>You don't have a feed yet. A feed is one calendar that families subscribe to, like "Room 12" or "U10 Hawks".</p>`
    : html`<ul class="events">${opts.feeds.map((f) => html`<li>
      <a href="/feeds/${f.id}"><strong dir="auto">${f.name}</strong></a>
      ${f.reviewCount > 0 ? html` <span class="error" style="padding:.1rem .5rem">${f.reviewCount} to review</span>` : ""}
      <span class="when">${f.subscribers === null ? "" : `At least ${f.subscribers} ${f.subscribers === 1 ? "calendar follows" : "calendars follow"} · `}updated ${new Date(f.lastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${f.visibility}</span>
    </li>`)}</ul>`}
  <p><a class="button" href="/feeds/new">New feed</a></p>
  <p><a href="/account">Your account</a></p>
</div>`);
}

export function newFeedPage(opts: { csrf: string; error?: string; values?: Record<string, string> }): Html {
  const v = opts.values ?? {};
  return layout("New feed", html`<div class="card">
  <h1>New feed</h1>
  ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
  <form method="post" action="/feeds/new">${csrf(opts.csrf)}
    <p><label for="name">Name</label><input class="copy" id="name" name="name" required maxlength="120" value="${v.name ?? ""}" placeholder="Room 12 families" dir="auto"></p>
    <p><label for="category">Kind</label><select class="copy" id="category" name="category">${CATEGORIES.map((c) => html`<option value="${c}" ${v.category === c ? "selected" : ""}>${c}</option>`)}</select></p>
    <p><label for="visibility">Who can find it</label><select class="copy" id="visibility" name="visibility">
      <option value="unlisted" ${v.visibility !== "public" && v.visibility !== "private" ? "selected" : ""}>Anyone with the link (recommended)</option>
      <option value="private" ${v.visibility === "private" ? "selected" : ""}>Only people I send the calendar link to</option>
      <option value="public" ${v.visibility === "public" ? "selected" : ""}>Listed publicly</option>
    </select></p>
    <p class="muted">School and youth feeds start as "anyone with the link", to protect children's details. You can change it later.</p>
    <button type="submit">Create feed</button>
  </form>
</div>`);
}

// ---------------------------------------------------------------- feed home: review queue
export interface ReviewCard {
  id: string;
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
export interface DraftCard { id: string; title: string; when: { starts_at: string; all_day: boolean; timezone: string }; location: string | null; confidence: number | null; quote: string | null }
export interface EventRow { id: string; title: string; when: { starts_at: string; all_day: boolean; timezone: string }; location: string | null; status: string }

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
  done?: string | undefined; undo?: { id: string; back: string } | null | undefined;
}): Html {
  const sure = opts.cards.filter(isSure).length + opts.drafts.filter((d) => (d.confidence ?? 0) >= 0.85).length;
  const t = opts.csrf;
  return layout(opts.name, html`${banner(opts.done, opts.undo ?? null, t)}
<div class="card">
  <h1 dir="auto">${opts.name}</h1>
  ${feedNav(opts.feedId, "home")}
  ${opts.cards.length + opts.drafts.length === 0
    ? html`<p class="muted">Nothing to review. New emails are read within a few minutes of arriving.</p>`
    : html`<p>${opts.cards.length + opts.drafts.length} to review.</p>
  ${sure > 0 ? html`<form method="post" action="/feeds/${opts.feedId}/approve-sure">${csrf(t)}<button type="submit">Approve all ${sure} marked Sure</button></form>` : ""}`}
</div>
${opts.cards.map((c) => html`<div class="card">
  <h2 dir="auto">${c.title} <span class="muted" style="font-size:1rem">${isSure(c) ? "Sure" : "Check this"}</span></h2>
  ${what(c)}
  ${c.reviewReasons.map((r) => html`<p class="${r === "possible_injection" ? "error" : "muted"}">${REVIEW_LABELS[r] ?? r}</p>`)}
  ${c.imageUrl ? html`<p><img src="${c.imageUrl}" alt="The page this came from" style="max-width:100%;border-radius:8px"></p>` : ""}
  <blockquote class="muted" dir="auto" style="margin:0 0 1rem;border-left:4px solid #e3e3df;padding-left:.75rem">…${c.evidence.before}<mark>${c.evidence.quote}</mark>${c.evidence.after}…<br><small>${c.evidence.where}</small></blockquote>
  ${c.originalUrl ? html`<p><a href="${c.originalUrl}" target="_blank" rel="noopener">Open the original file</a></p>` : ""}
  <div class="row">
    <form method="post" action="/feeds/${opts.feedId}/candidates/${c.id}/approve">${csrf(t)}<button type="submit">Approve</button></form>
  </div>
  <details><summary>Edit, then approve</summary>
    <form method="post" action="/feeds/${opts.feedId}/candidates/${c.id}/approve">${csrf(t)}
      <p><label for="t-${c.id}">Title</label><input class="copy" id="t-${c.id}" name="title" value="${c.title}" dir="auto"></p>
      <p><label for="d-${c.id}">Date</label><input class="copy" type="date" id="d-${c.id}" name="date" value="${c.date}"></p>
      ${c.when.all_day ? "" : html`<p><label for="h-${c.id}">Time</label><input class="copy" type="time" id="h-${c.id}" name="time" value="${c.time}"></p>`}
      <p><label for="l-${c.id}">Place</label><input class="copy" id="l-${c.id}" name="location" value="${c.location ?? ""}" dir="auto"></p>
      <button type="submit">Save and approve</button>
    </form>
  </details>
  <details><summary>Reject</summary>
    <form method="post" action="/feeds/${opts.feedId}/candidates/${c.id}/reject">${csrf(t)}
      <p><label for="r-${c.id}">Why?</label><select class="copy" id="r-${c.id}" name="reason">${Object.entries(REJECT_REASONS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></p>
      <p><label for="n-${c.id}">Note (optional, helps Feedcal learn)</label><input class="copy" id="n-${c.id}" name="note" maxlength="500"></p>
      <button type="submit" class="danger">Reject</button>
    </form>
  </details>
</div>`)}
${opts.drafts.map((d) => html`<div class="card">
  <h2 dir="auto">${d.title} <span class="muted" style="font-size:1rem">Draft${(d.confidence ?? 0) >= 0.85 ? " · Sure" : ""}</span></h2>
  <p>${formatWhen(d.when)}${d.location ? html` · <span dir="auto">${d.location}</span>` : ""}</p>
  ${d.quote ? html`<blockquote class="muted" dir="auto"><mark>${d.quote}</mark></blockquote>` : ""}
  <div class="row">
    <form method="post" action="/feeds/${opts.feedId}/drafts/${d.id}/publish">${csrf(t)}<button type="submit">Publish</button></form>
    <a class="button secondary" href="/feeds/${opts.feedId}/events/${d.id}">Edit</a>
    <form method="post" action="/feeds/${opts.feedId}/drafts/${d.id}/discard">${csrf(t)}<button type="submit" class="secondary">Discard</button></form>
  </div>
</div>`)}
<div class="card">
  <h2>Coming up</h2>
  ${opts.upcoming.length === 0
    ? html`<p class="muted">No upcoming events yet. <a href="/feeds/${opts.feedId}/events/new">Add one</a>, or forward an email.</p>`
    : html`<ul class="events">${opts.upcoming.map((e) => html`<li><a href="/feeds/${opts.feedId}/events/${e.id}"><strong dir="auto">${e.title}</strong></a>${e.status === "cancelled" ? html` <span class="muted">(cancelled)</span>` : ""}<span class="when">${formatWhen(e.when)}${e.location ? html` · <span dir="auto">${e.location}</span>` : ""}</span></li>`)}</ul>`}
</div>`);
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
  ${opts.status === "cancelled" ? html`<p class="error">This event is cancelled.</p>` : ""}
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
  ? html`<div class="card"><h2>History</h2><ul class="events">${opts.history.map((h) => html`<li>${CAUSES[h.cause] ?? h.cause}<span class="when">${new Date(h.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: opts.timezone })} · ${h.actor === "ai" ? "Feedcal" : h.actor.startsWith("user:") ? "a person" : h.actor}</span></li>`)}</ul></div>`
  : ""}`);
}

// ---------------------------------------------------------------- settings
export interface SettingsData {
  name: string; description: string; visibility: string; timezone: string; threshold: number; isOwner: boolean;
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
    <p><label for="name">Name</label><input class="copy" id="name" name="name" required maxlength="120" value="${s.name}" dir="auto"></p>
    <p><label for="description">Description</label><textarea id="description" name="description" rows="2" maxlength="2000" dir="auto">${s.description}</textarea></p>
    <p><label for="visibility">Who can find it</label><select class="copy" id="visibility" name="visibility">
      ${(["unlisted", "private", "public"] as const).map((v) => html`<option value="${v}" ${s.visibility === v ? "selected" : ""}>${v === "unlisted" ? "Anyone with the link" : v === "private" ? "Only people I send the calendar link to" : "Listed publicly"}</option>`)}
    </select></p>
    <p><label for="timezone">Time zone</label><input class="copy" id="timezone" name="timezone" value="${s.timezone}" pattern="[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}"></p>
    <p><label for="threshold">Publish automatically when Feedcal is at least this sure (from trusted senders)</label>
      <select class="copy" id="threshold" name="threshold">${[0.7, 0.8, 0.85, 0.9, 0.95, 1].map((n) => html`<option value="${n}" ${Math.abs(s.threshold - n) < 0.001 ? "selected" : ""}>${n === 1 ? "Never: I review everything" : `${Math.round(n * 100)}%`}</option>`)}</select></p>
    <button type="submit">Save settings</button>
  </form>`
    : html`<p class="muted">Only the owner can change these settings.</p>`}
</div>
${s.isOwner ? html`<div class="card">
  <h2>Verified badge</h2>
  <p>Families trust calendars from verified organizers. We verify automatically when you sign in with your organisation's email and it sends this feed's emails.</p>
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
    <p><label for="editor">Add an editor by email</label><input class="copy" type="email" id="editor" name="email" required maxlength="320"></p>
    <button type="submit" class="secondary">Add editor</button></form>` : ""}
</div>
${s.isOwner ? html`<div class="card">
  <h2>Delete this feed</h2>
  <p>Subscribers stop getting updates at once. You'll have 10 seconds to undo.</p>
  <form method="post" action="/feeds/${opts.feedId}/delete">${csrf(t)}
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> Delete this feed and all its events</label></p>
    <button type="submit" class="danger">Delete feed</button></form>
</div>` : ""}`);
}
