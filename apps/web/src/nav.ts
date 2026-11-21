import { html } from "hono/html";

/** The feed menu on every organizer page of a feed (review, events, share, email, settings). */
export const feedNav = (feedId: string, here: string) => html`<p class="row no-print" style="gap:1rem">
  <a href="/feeds">All feeds</a>
  ${here === "home" ? html`<strong>Review</strong>` : html`<a href="/feeds/${feedId}">Review</a>`}
  <a href="/feeds/${feedId}/events/new">Add event</a>
  ${here === "share" ? html`<strong>Share</strong>` : html`<a href="/feeds/${feedId}/share">Share</a>`}
  ${here === "email" ? html`<strong>Email</strong>` : html`<a href="/feeds/${feedId}/email">Email</a>`}
  ${here === "gmail" ? html`<strong>Gmail</strong>` : html`<a href="/feeds/${feedId}/gmail">Gmail</a>`}
  ${here === "settings" ? html`<strong>Settings</strong>` : html`<a href="/feeds/${feedId}/settings">Settings</a>`}
</p>`;
