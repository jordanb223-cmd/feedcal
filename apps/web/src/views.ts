import { html } from "hono/html";
import { ASSET_PATHS } from "./assets.js";

/** D62: shown at the foot of every page (calendar pages also carry the longer notes). */
export const FOOTER_DISCLAIMER = "Bumpdraft fills calendars in automatically and can make mistakes. It isn't run by any school or team.";
import type { HtmlEscapedString } from "hono/utils/html";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// "Lantern paper" (DESIGN.md part 4, D67): cream page, serif headlines, the lantern orange.
// The colours and their computed contrast are listed at the top of the stylesheet (assets.ts).

/**
 * Every page has a way to move on (2026-11-21). Organizer pages: Feedcal · Your calendars · Account.
 * Public pages (what families and visitors see): Feedcal · Find a calendar, with no organizer
 * links. Messages and errors: just the Feedcal home link.
 */
export type Audience = "organizer" | "public" | "minimal";

function siteHeader(audience: Audience): Html {
  if (audience === "public") {
    return html`<nav class="site no-print" aria-label="Site"><a class="brand" href="/directory">Bumpdraft</a><a href="/directory">Find a calendar</a></nav>`;
  }
  if (audience === "minimal") {
    return html`<nav class="site no-print" aria-label="Site"><a class="brand" href="/">Bumpdraft</a></nav>`;
  }
  return html`<nav class="site no-print" aria-label="Site"><a class="brand" href="/">Bumpdraft</a><a href="/feeds">Your calendars</a><a href="/account">Account</a></nav>`;
}

/** For pages anyone can see without signing in. */
export function publicLayout(title: string, body: Html, head: Html | string = ""): Html {
  return layout(title, body, head, "public");
}

export function layout(title: string, body: Html, head: Html | string = "", audience: Audience = "organizer"): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Bumpdraft</title>
${head}
<link rel="stylesheet" href="${ASSET_PATHS.css}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#f6efe2">
<script src="${ASSET_PATHS.js}" defer></script>
</head>
<body><a class="skip" href="#main">Skip to content</a><main id="main">${siteHeader(audience)}${body}
<footer class="no-print"><p>${FOOTER_DISCLAIMER}</p><nav aria-label="Footer"><a href="/directory">Find a calendar</a><a href="/rules">Community rules</a><a href="/terms">Terms</a><a href="/takedown">Reports</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a><a href="/about/costs">Support Bumpdraft</a></nav></footer></main></body>
</html>`;
}

const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;

export function loginPage(opts: { csrf: string; googleEnabled: boolean; error?: string; email?: string; next?: string }): Html {
  return publicLayout(
    "Sign in",
    html`<div class="card panel">
  <h1>Sign in to Bumpdraft</h1>
  ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
  <form method="post" action="/login">
    ${csrfField(opts.csrf)}
    <label for="email">Email address</label>
    <p class="muted" id="email-hint">We'll email you a sign-in link. No password needed.</p>
    <p><input id="email" name="email" type="email" autocomplete="email" spellcheck="false" required maxlength="320"
      aria-describedby="email-hint" value="${opts.email ?? ""}"></p>
    <button type="submit">Email me a sign-in link</button>
  </form>
  ${opts.googleEnabled
    ? html`<p class="sep muted">or</p>
  <form method="post" action="/auth/google">
    ${csrfField(opts.csrf)}
    <input type="hidden" name="next" value="${opts.next ?? ""}">
    <button type="submit" class="secondary">Sign in with Google</button>
  </form>`
    : ""}
</div>`,
  );
}

export function checkEmailPage(): Html {
  return publicLayout(
    "Check your email",
    html`<div class="card">
  <h1>Check your email</h1>
  <p>If that address can sign in, a link is on its way. It works once and expires in 15 minutes.</p>
  <p class="muted">Nothing after a few minutes? Check spam, or <a href="/login">try again</a>.</p>
</div>`,
  );
}

export function confirmPage(opts: { csrf: string; tokenHash: string; type: string }): Html {
  return publicLayout(
    "Finish signing in",
    html`<div class="card">
  <h1>Finish signing in</h1>
  <p>Tap the button to sign in on this device.</p>
  <form method="post" action="/auth/confirm">
    ${csrfField(opts.csrf)}
    <input type="hidden" name="token_hash" value="${opts.tokenHash}">
    <input type="hidden" name="type" value="${opts.type}">
    <button type="submit">Sign in</button>
  </form>
</div>`,
  );
}

export function messagePage(title: string, message: string, link?: { href: string; text: string }): Html {
  return layout(
    title,
    html`<div class="card">
  <h1>${title}</h1>
  <p role="alert">${message}</p>
  ${link ? html`<p><a class="button" href="${link.href}">${link.text}</a></p>` : ""}
</div>`,
    "",
    "minimal",
  );
}

export function errorPage(opts: { title: string; message: string; tryThis: string; requestId: string }): Html {
  return layout(
    opts.title,
    html`<div class="card">
  <h1>${opts.title}</h1>
  <p role="alert">${opts.message}</p>
  <p>${opts.tryThis}</p>
  <p class="row"><a class="button" href="/account">Go to your account</a></p>
  <p class="muted">If it keeps happening, tell us this code: <code>${opts.requestId}</code></p>
</div>`,
    "",
    "minimal",
  );
}

export function accountPage(opts: {
  csrf: string;
  email: string | null;
  displayName: string | null;
  deletionDate: string | null;
  /** From the database; null if it couldn't be read. */
  graceDays: number | null;
  feeds: { id: string; name: string; visibility: string }[];
  notifications?: { weekly_digest: boolean; instant_reports: boolean; staleness: boolean; milestones: boolean; published_events?: boolean };
  notice?: string;
}): Html {
  const n = opts.notifications ?? { weekly_digest: true, instant_reports: true, staleness: true, milestones: true };
  return layout(
    "Your account",
    html`<div class="card">
  <h1>Your account</h1>
  ${opts.notice ? html`<p role="status">${opts.notice}</p>` : ""}
  <p>Signed in as <strong>${opts.email ?? "your account"}</strong>${opts.displayName ? html` (<span dir="auto">${opts.displayName}</span>)` : ""}.</p>
  <div class="row">
    <form method="post" action="/logout">${csrfField(opts.csrf)}<button type="submit" class="secondary">Sign out</button></form>
    <form method="post" action="/logout-everywhere">${csrfField(opts.csrf)}<button type="submit" class="secondary">Sign out everywhere</button></form>
  </div>
</div>
<div class="split">
<div>
<div class="card">
  <h2>Emails from Bumpdraft</h2>
  <form method="post" action="/account/notifications">
    ${csrfField(opts.csrf)}
    <p><label class="check"><input type="checkbox" name="published_events" value="1" ${n.published_events === false ? "" : "checked"}> Right away when Bumpdraft adds or changes an event by itself</label></p>
    <p><label class="check"><input type="checkbox" name="weekly_digest" value="1" ${n.weekly_digest ? "checked" : ""}> A weekly summary every Monday</label></p>
    <p><label class="check"><input type="checkbox" name="instant_reports" value="1" ${n.instant_reports ? "checked" : ""}> Right away when a subscriber reports a problem</label></p>
    <p><label class="check"><input type="checkbox" name="staleness" value="1" ${n.staleness ? "checked" : ""}> A reminder when a calendar goes quiet</label></p>
    <p><label class="check"><input type="checkbox" name="milestones" value="1" ${n.milestones ? "checked" : ""}> A thank-you when a calendar reaches 10, 50 or 100 followers</label></p>
    <button type="submit" class="secondary">Save email choices</button>
  </form>
</div>
</div>
<aside>
<div class="card">
  <h2>Your data</h2>
  <p><a href="/account/export">Download everything Bumpdraft holds about you</a> (JSON).</p>
  ${opts.feeds.length > 0 ? html`<p>Each calendar as a file: ${opts.feeds.map((f, i) => html`${i > 0 ? ", " : ""}<a href="/account/export/${f.id}.ics" dir="auto">${f.name}</a>`)}.</p>` : ""}
  <p class="muted"><a href="/privacy">How Bumpdraft handles your data</a></p>
</div>
<div class="card">
  <h2>Supporting Bumpdraft</h2>
  <p><a href="/account/support">Link your Buy Me a Coffee support</a> or choose whether you're listed as a supporter.</p>
</div>
</aside>
</div>
${opts.deletionDate ? html`<div class="card"><h2>Delete your account</h2>` : html`<details class="more card"><summary>Delete your account</summary>`}
  ${opts.deletionDate
    ? html`<p class="error" role="alert">Your account will be deleted on <strong>${opts.deletionDate}</strong>.</p>
  <form method="post" action="/account/cancel-delete">${csrfField(opts.csrf)}<button type="submit">Keep my account</button></form>`
    : html`<p>We wait ${opts.graceDays ? `${opts.graceDays} days` : "a short grace period"}, then delete your personal data. Calendars you own go to a co-editor if they have one; otherwise they're deleted.</p>
  <form method="post" action="/account/delete">
    ${csrfField(opts.csrf)}
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand my account will be deleted ${opts.graceDays ? `in ${opts.graceDays} days` : "after the grace period"}.</label></p>
    <button type="submit" class="danger">Delete my account</button>
  </form>`}
${opts.deletionDate ? html`</div>` : html`</details>`}`,
  );
}
