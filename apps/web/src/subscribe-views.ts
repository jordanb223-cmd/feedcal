import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { PublicFeedPage } from "@feedcal/shared";
import type { Device, SubscribeLinks } from "./subscribe-links.js";
import { feedNav } from "./nav.js";
import { layout, publicLayout } from "./views.js";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
type PageEvent = PublicFeedPage["events"][number];

/** "Tue, Nov 24 · 5:00 PM", or "Wed, Nov 25 · All day", in the event's own zone. */
export function formatWhen(e: Pick<PageEvent, "starts_at" | "all_day" | "timezone">): string {
  const date = new Date(e.starts_at);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: e.timezone, weekday: "short", month: "short", day: "numeric" }).format(date);
  if (e.all_day) return `${day} · All day`;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: e.timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
  return `${day} · ${time}`;
}

function formatUpdated(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

const PRIMARY: Record<Device, { target: string; label: string }> = {
  apple: { target: "apple", label: "Add to Apple Calendar" },
  android: { target: "google", label: "Add to Google Calendar" },
  windows: { target: "outlook", label: "Add to Outlook" },
  other: { target: "google", label: "Add to Google Calendar" },
};


/** schema.org Events for search engines (public feeds only). "<" is escaped so it can't end the script. */
export function jsonLd(name: string, url: string, events: PublicFeedPage["events"]): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url,
    itemListElement: events.slice(0, 50).map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Event",
        name: e.title,
        startDate: e.all_day ? e.starts_at.slice(0, 10) : e.starts_at,
        ...(e.ends_at ? { endDate: e.all_day ? e.ends_at.slice(0, 10) : e.ends_at } : {}),
        eventStatus: e.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
        ...(e.location ? { location: { "@type": "Place", name: e.location } } : {}),
        ...(e.description ? { description: e.description.slice(0, 500) } : {}),
      },
    })),
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function subscribePage(opts: { page: PublicFeedPage; device: Device; links: SubscribeLinks; pageUrl: string }): Html {
  const { feed, events } = opts.page;
  const next = events.slice(0, 5);
  const go = (target: string) => `/c/${encodeURIComponent(feed.slug)}/go/${target}`;
  const primary = PRIMARY[opts.device];
  const n = feed.subscribers_at_least;
  const description = feed.description ?? `Upcoming events from ${feed.name}, kept up to date automatically.`;
  const head = html`<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${feed.name}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${opts.pageUrl}">
<meta name="twitter:card" content="summary">
${feed.visibility === "unlisted" ? html`<meta name="robots" content="noindex">` : ""}
${feed.visibility === "public" ? raw(`<script type="application/ld+json">${jsonLd(feed.name, opts.pageUrl, events)}</script>`) : ""}`;

  return publicLayout(
    feed.name,
    html`<div class="card">
  <h1 dir="auto">${feed.name}${feed.verified ? html` <span title="Verified organizer" style="font-size:1rem">✓ Verified</span>` : ""}</h1>
  ${feed.may_be_out_of_date ? html`<p class="error" role="alert">This calendar hasn't been updated in over 90 days, so it may be out of date.</p>` : ""}
  ${feed.organizer_name ? html`<p class="muted">Kept up to date by <span dir="auto">${feed.organizer_name}</span>${feed.area ? html` · <span dir="auto">${feed.area}</span>` : feed.zip_code ? html` · ${feed.zip_code}` : ""}</p>` : ""}
  ${feed.description ? html`<p dir="auto">${feed.description}</p>` : ""}
  <p><a class="button wide" href="${go(primary.target)}">${primary.label}</a></p>
  <details>
    <summary>Other ways to subscribe</summary>
    <p><a class="button secondary wide" href="${go("apple")}">Apple Calendar (iPhone, iPad, Mac)</a></p>
    <p><a class="button secondary wide" href="${go("google")}">Google Calendar</a></p>
    <p class="muted">Using an Android phone? Google's app can't add a calendar from a link. The button above opens Google Calendar in your browser. If it says it can't add the calendar, open calendar.google.com on a computer, choose <strong>Other calendars → + → From URL</strong>, and paste the link below.</p>
    <p><a class="button secondary wide" href="${go("outlook")}">Outlook.com</a></p>
    <p><a class="button secondary wide" href="${go("office365")}">Outlook for work or school (Microsoft 365)</a></p>
    <p><label for="feed-link">Calendar link for any other app</label>
      <input class="copy" id="feed-link" readonly spellcheck="false" value="${opts.links.https}"></p>
    <p><button type="button" class="secondary" data-copy="feed-link" data-count="/c/${encodeURIComponent(feed.slug)}/copied">Copy link</button></p>
  </details>
  <p class="muted">${n > 0 ? html`At least ${n} ${n === 1 ? "calendar follows" : "calendars follow"} this. ` : ""}Updated ${formatUpdated(feed.last_updated_at)}.</p>
  ${n > 0 ? html`<p class="muted" style="font-size:.875rem">How we count: calendar apps that checked for updates in the last 7 days. Google checks once for all its users, so the real number is often higher.</p>` : ""}
  ${subscriberNotes(feed.verified === true)}
</div>
<div class="card">
  <h2>Coming up</h2>
  ${next.length === 0
    ? html`<p class="muted">No upcoming events yet. Subscribe now and new ones will appear in your calendar on their own.</p>`
    : html`<ul class="events">${next.map((e) => html`<li><strong dir="auto">${e.title}</strong><span class="when">${formatWhen(e)}${e.location ? html` · <span dir="auto">${e.location}</span>` : ""}</span></li>`)}</ul>`}
</div>
<p class="muted no-print" style="text-align:center"><a href="/c/${feed.slug}/report">Report this calendar</a></p>`,
    head,
  );
}

export function shareKitPage(opts: {
  csrf: string;
  feedId: string;
  name: string;
  visibility: "public" | "unlisted" | "private";
  pageUrl: string | null;
  feedUrl: string;
  qrSvg: string;
  chatText: string;
  stats: { subscribers_at_least: number; clicks_30d: Record<string, number> } | null;
  notice?: string;
}): Html {
  const clicks = opts.stats ? Object.values(opts.stats.clicks_30d).reduce((a, b) => a + b, 0) : 0;
  return layout(
    `Share ${opts.name}`,
    html`<div class="card">
  ${feedNav(opts.feedId, "share")}
  <h1>Share <span dir="auto">${opts.name}</span></h1>
  ${opts.notice ? html`<p role="status">${opts.notice}</p>` : ""}
  ${opts.pageUrl
    ? html`<p>Send people this page. It has a one-tap subscribe button for their phone.</p>
  <p><label for="page-link">Page link</label><input class="copy" id="page-link" readonly spellcheck="false" value="${opts.pageUrl}"></p>
  <p><button type="button" class="secondary" data-copy="page-link">Copy page link</button></p>`
    : html`<p>This feed is private, so it has no public page. Share the calendar link directly with the people who should see it.</p>`}
  <p><label for="feed-url">Calendar link (for calendar apps)</label><input class="copy" id="feed-url" readonly spellcheck="false" value="${opts.feedUrl}"></p>
  <p><button type="button" class="secondary" data-copy="feed-url">Copy calendar link</button></p>
</div>
<div class="card">
  <h2>QR code</h2>
  <div class="qr" role="img" aria-label="QR code for ${opts.pageUrl ?? opts.feedUrl}">${raw(opts.qrSvg)}</div>
  <p class="muted">Points to ${opts.pageUrl ? "the page link" : "the calendar link"}.</p>
  <p><a class="button secondary" href="/feeds/${opts.feedId}/flyer">Printable flyer</a></p>
</div>
<div class="card">
  <h2>Group chat message</h2>
  <p><label for="chat-text">Copy and paste into your group chat</label><textarea id="chat-text" rows="4" readonly>${opts.chatText}</textarea></p>
  <p><button type="button" class="secondary" data-copy="chat-text">Copy message</button></p>
</div>
${opts.stats
  ? html`<div class="card">
  <h2>Who's following</h2>
  <p>At least ${opts.stats.subscribers_at_least} ${opts.stats.subscribers_at_least === 1 ? "calendar" : "calendars"} checked this feed in the last 7 days. Subscribe buttons were tapped ${clicks} ${clicks === 1 ? "time" : "times"} in the last 30 days.</p>
  <p class="muted" style="font-size:.875rem">Google checks once for all its users, so the real number is often higher.</p>
</div>`
  : ""}
<div class="card">
  <h2>Make a new calendar link</h2>
  <p>If the link reached the wrong people, make a new one. The old link stops working right away, and current subscribers will need the new one.</p>
  <form method="post" action="/feeds/${opts.feedId}/rotate-token">
    <input type="hidden" name="csrf" value="${opts.csrf}">
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand current subscribers will stop getting updates until they use the new link</label></p>
    <button type="submit" class="danger">Make a new link</button>
  </form>
</div>`,
  );
}

export function flyerPage(opts: { name: string; url: string; qrSvg: string; feedId: string }): Html {
  return publicLayout(
    `${opts.name} flyer`,
    html`<div class="card" style="text-align:center">
  <h1 dir="auto" style="font-size:2rem">${opts.name}</h1>
  <p style="font-size:1.25rem">Get every event in your phone's calendar. It updates on its own.</p>
  <div class="qr" role="img" aria-label="QR code for ${opts.url}" style="margin:1.5rem 0">${raw(opts.qrSvg)}</div>
  <p style="font-size:1.125rem"><strong>1.</strong> Point your phone's camera at the code. <strong>2.</strong> Tap the link. <strong>3.</strong> Tap Subscribe.</p>
  <p class="muted" style="word-break:break-all">${opts.url}</p>
  <p class="no-print"><button type="button" data-print>Print</button> <a class="button secondary" href="/feeds/${opts.feedId}/share">Back</a></p>
</div>`,
  );
}

// D44: what a subscriber should know. They never see the terms page, so it's said here.
export const NOTE_ACCURACY = "Feedcal fills this calendar in automatically, from emails and other calendars, and it can make mistakes. Check important details (dates, times, places) with the organizer.";
export const NOTE_UNOFFICIAL = "Not run or endorsed by any school, team or group named in it, unless they say so.";
export const NOTE_REFRESH = "Your calendar app checks for changes on its own schedule, so updates can take a few hours to show.";
function subscriberNotes(verified: boolean) {
  return html`<div class="notes muted" style="font-size:.875rem">
    <p>${NOTE_ACCURACY}</p>
    ${verified ? "" : html`<p>${NOTE_UNOFFICIAL}</p>`}
    <p>${NOTE_REFRESH}</p>
  </div>`;
}
