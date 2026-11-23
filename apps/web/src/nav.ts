import { html } from "hono/html";

/** The menu on every organizer page of a calendar (review, events, share, email, settings): tabs that scroll sideways on a phone. */
export const feedNav = (feedId: string, here: string) => html`<nav class="tabs no-print" aria-label="This calendar">
  ${here === "home" ? html`<strong aria-current="page">Review</strong>` : html`<a href="/feeds/${feedId}">Review</a>`}
  ${here === "event" ? html`<strong aria-current="page">Add event</strong>` : html`<a href="/feeds/${feedId}/events/new">Add event</a>`}
  ${here === "share" ? html`<strong aria-current="page">Share</strong>` : html`<a href="/feeds/${feedId}/share">Share</a>`}
  ${here === "email" ? html`<strong aria-current="page">Email</strong>` : html`<a href="/feeds/${feedId}/email"${here === "gmail" ? html` aria-current="page"` : ""}>Email</a>`}
  ${here === "settings" ? html`<strong aria-current="page">Settings</strong>` : html`<a href="/feeds/${feedId}/settings">Settings</a>`}
</nav>`;
