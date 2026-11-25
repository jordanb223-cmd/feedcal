// How to stop following a calendar, in each calendar app. Every email Bumpdraft sends links
// here (LEAVE_PATH in supabase/functions/_shared/notify/templates.ts). Following happens in the
// person's own calendar app, so leaving does too: Bumpdraft keeps no list of who follows.
import type { Hono } from "hono";
import { html } from "hono/html";
import { seoHead } from "./seo.js";
import type { AppEnv } from "./types.js";
import { publicLayout } from "./views.js";

export function registerHelpRoutes(app: Hono<AppEnv>): void {
  app.get("/help/unsubscribe", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(publicLayout("Stop following a calendar", html`<div class="card">
  <h1>Stop following a calendar</h1>
  <p>You unsubscribe in your own calendar app. It takes a few taps, and the calendar's events leave your phone. You can add it again any time from its link or QR code.</p>
  <p class="muted">Menu names change from time to time. If a step doesn't match, look for the calendar's name in your app's list of calendars.</p>
  <details open><summary>iPhone or iPad (Apple Calendar)</summary>
    <ol>
      <li>Open the <strong>Calendar</strong> app.</li>
      <li>Tap <strong>Calendars</strong> at the bottom of the screen.</li>
      <li>Tap the <strong>ⓘ</strong> next to the calendar's name.</li>
      <li>Scroll down and tap <strong>Unsubscribe</strong> (on older versions, <strong>Delete Calendar</strong>).</li>
    </ol>
  </details>
  <details><summary>Google Calendar</summary>
    <ol>
      <li>On a computer, open <a href="https://calendar.google.com/calendar/r/settings" rel="noopener">Google Calendar's settings</a>.</li>
      <li>On the left, under <strong>Settings for other calendars</strong>, click the calendar's name.</li>
      <li>Click <strong>Remove calendar</strong>, then <strong>Unsubscribe</strong>.</li>
    </ol>
    <p class="muted">The Google Calendar phone app can hide a calendar but can't remove it, so use a computer or your phone's browser.</p>
  </details>
  <details><summary>Outlook</summary>
    <ol>
      <li>Open <a href="https://outlook.live.com/calendar/" rel="noopener">your Outlook calendar</a> (work or school accounts: <a href="https://outlook.office.com/calendar/" rel="noopener">Microsoft 365</a>).</li>
      <li>In the list of calendars on the left, right-click the calendar's name, or click the <strong>…</strong> next to it.</li>
      <li>Choose <strong>Remove</strong>.</li>
    </ol>
  </details>
  <details><summary>Calendar on a Mac</summary>
    <ol>
      <li>Open <strong>Calendar</strong>. If the list of calendars is hidden, click the calendar button at the top left.</li>
      <li>Right-click the calendar's name and choose <strong>Unsubscribe</strong>.</li>
    </ol>
  </details>
  <p class="muted">Something wrong with the calendar instead? Each event has a "Report a problem" link, or <a href="/contact">tell us</a>.</p>
</div>`, seoHead(c, "Stop following a calendar", "How to unsubscribe from a Bumpdraft calendar in Apple Calendar, Google Calendar and Outlook.")));
  });
}
