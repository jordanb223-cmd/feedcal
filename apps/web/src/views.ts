import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// Colors checked for WCAG AA contrast: text #1d1d1b on #f6f6f4 (16.5:1), white on #1f5f3f (7.6:1),
// muted #4f4f4b on #ffffff (8.3:1), error #8a1c1c on #fdf1f1 (7.9:1).
const styles = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d1d1b;background:#f6f6f4}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem}
.card{background:#fff;border-radius:12px;padding:1.5rem;margin:0 0 1rem}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 1rem}
h2{font-size:1.25rem;line-height:1.3;margin:0 0 .75rem}
p{margin:0 0 1rem}
.muted{color:#4f4f4b}
label{display:block;font-weight:600;margin:0 0 .25rem}
input[type=email]{width:100%;font:inherit;padding:.75rem;border:2px solid #6b6b66;border-radius:8px}
button,.button{display:inline-block;font:inherit;font-weight:600;padding:.75rem 1.25rem;border-radius:8px;border:2px solid #1f5f3f;background:#1f5f3f;color:#fff;cursor:pointer;text-decoration:none}
button.secondary{background:#fff;color:#1f5f3f}
button.danger{background:#8a1c1c;border-color:#8a1c1c}
form{margin:0 0 1rem}
:focus-visible{outline:3px solid #1a4fd6;outline-offset:2px}
.error{background:#fdf1f1;color:#8a1c1c;border-left:4px solid #8a1c1c;padding:.75rem 1rem;border-radius:4px}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
.row{display:flex;flex-wrap:wrap;gap:.5rem}
.sep{text-align:center;margin:1rem 0}
a.button{margin:0 0 .5rem}
a.button.secondary{background:#fff;color:#1f5f3f}
.wide{display:block;width:100%;text-align:center}
.events{list-style:none;padding:0;margin:0}
.events li{padding:.75rem 0;border-top:1px solid #e3e3df}
.events li:first-child{border-top:0}
.when{display:block;font-size:.95rem;color:#4f4f4b}
details summary{cursor:pointer;font-weight:600;padding:.5rem 0}
textarea,input.copy{width:100%;font:inherit;padding:.75rem;border:2px solid #6b6b66;border-radius:8px}
.qr svg{width:12rem;height:12rem;display:block;margin:0 auto}
@media print{body{background:#fff}.no-print{display:none}.card{padding:0}}
`;

export function layout(title: string, body: Html, head: Html | string = ""): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Feedcal</title>
${head}
<style>${raw(styles)}</style>
</head>
<body><main id="main">${body}</main></body>
</html>`;
}

const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;

export function loginPage(opts: { csrf: string; googleEnabled: boolean; error?: string; email?: string; next?: string }): Html {
  return layout(
    "Sign in",
    html`<div class="card">
  <h1>Sign in to Feedcal</h1>
  ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
  <form method="post" action="/login">
    ${csrfField(opts.csrf)}
    <label for="email">Email address</label>
    <p class="muted" id="email-hint">We'll email you a sign-in link. No password needed.</p>
    <p><input id="email" name="email" type="email" autocomplete="email" required maxlength="320"
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
  return layout(
    "Check your email",
    html`<div class="card">
  <h1>Check your email</h1>
  <p>If that address can sign in, a link is on its way. It works once and expires in 15 minutes.</p>
  <p class="muted">Nothing after a few minutes? Check spam, or <a href="/login">try again</a>.</p>
</div>`,
  );
}

export function confirmPage(opts: { csrf: string; tokenHash: string; type: string }): Html {
  return layout(
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
  notice?: string;
}): Html {
  return layout(
    "Your account",
    html`<div class="card">
  <h1>Your account</h1>
  ${opts.notice ? html`<p role="status">${opts.notice}</p>` : ""}
  <p>Signed in as <strong>${opts.email ?? "your account"}</strong>${opts.displayName ? html` (${opts.displayName})` : ""}.</p>
  <div class="row">
    <form method="post" action="/logout">${csrfField(opts.csrf)}<button type="submit" class="secondary">Sign out</button></form>
    <form method="post" action="/logout-everywhere">${csrfField(opts.csrf)}<button type="submit" class="secondary">Sign out everywhere</button></form>
  </div>
</div>
<div class="card">
  <h2>Your feeds</h2>
  ${opts.feeds.length === 0
    ? html`<p class="muted">You don't have any feeds yet.</p>`
    : html`<ul class="events">${opts.feeds.map((f) => html`<li><strong>${f.name}</strong> <span class="muted">(${f.visibility})</span><span class="when"><a href="/feeds/${f.id}/share">Share and subscribe links</a></span></li>`)}</ul>`}
</div>
<div class="card">
  <h2>Delete your account</h2>
  ${opts.deletionDate
    ? html`<p class="error">Your account will be deleted on <strong>${opts.deletionDate}</strong>.</p>
  <form method="post" action="/account/cancel-delete">${csrfField(opts.csrf)}<button type="submit">Keep my account</button></form>`
    : html`<p>We wait ${opts.graceDays ? `${opts.graceDays} days` : "a short grace period"}, then delete your personal data. Feeds you own go to a co-editor if they have one; otherwise they're deleted.</p>
  <form method="post" action="/account/delete">
    ${csrfField(opts.csrf)}
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand my account will be deleted ${opts.graceDays ? `in ${opts.graceDays} days` : "after the grace period"}.</label></p>
    <button type="submit" class="danger">Delete my account</button>
  </form>`}
</div>`,
  );
}
