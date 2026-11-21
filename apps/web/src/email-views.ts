import { html } from "hono/html";
import { copyScript } from "./subscribe-views.js";
import { layout } from "./views.js";

type Html = ReturnType<typeof layout>;

export interface WaitingSender {
  sourceId: string;
  sender: string;
  count: number;
  latestSubject: string | null;
}
export interface SuspiciousMessage {
  id: string;
  sender: string | null;
  subject: string | null;
  receivedAt: string;
}

export const EMAIL_NOTICES = {
  approved: "Done. Emails from that sender will now be read for events.",
  declined: "Done. Emails from that sender will be ignored.",
  released: "Done. That email will be read for events.",
  ignored: "Done. That email was ignored.",
  rotated: "Your calendar has a new email address. The old one no longer works, so update any forwarding rules.",
} as const;
export type EmailNotice = keyof typeof EMAIL_NOTICES;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

export function emailSetupPage(opts: {
  csrf: string;
  feedId: string;
  name: string;
  isOwner: boolean;
  /** Null when this environment has no intake domain yet. */
  address: string | null;
  localPart: string;
  confirmation: { code: string; url: string | null; requestedBy: string | null } | null;
  senders: WaitingSender[];
  suspicious: SuspiciousMessage[];
  notice?: EmailNotice;
}): Html {
  const csrf = html`<input type="hidden" name="csrf" value="${opts.csrf}">`;
  const nothingWaiting = opts.senders.length === 0 && opts.suspicious.length === 0;
  return layout(
    `Email for ${opts.name}`,
    html`<div class="card">
  <h1>Email for <span dir="auto">${opts.name}</span></h1>
  ${opts.notice ? html`<p role="status">${EMAIL_NOTICES[opts.notice]}</p>` : ""}
  <p>Forward school or team emails to this address. Feedcal reads them and finds the events.</p>
  ${opts.address
    ? html`<p><label for="intake">This calendar's email address</label><input class="copy" id="intake" readonly value="${opts.address}"></p>
  <p><button type="button" class="secondary" data-copy="intake">Copy address</button></p>`
    : html`<p class="error">Email forwarding isn't switched on for this site yet, so this address doesn't receive mail. Your calendar's address will be <code>${opts.localPart}@…</code> once it is.</p>`}
</div>
${opts.confirmation
  ? html`<div class="card">
  <h2>Gmail confirmation code</h2>
  <p>Gmail sent a code to confirm forwarding${opts.confirmation.requestedBy ? html` from <strong>${opts.confirmation.requestedBy}</strong>` : ""}. Enter it in Gmail's forwarding settings:</p>
  <p style="font-size:2rem;font-weight:700;letter-spacing:.1em">${opts.confirmation.code}</p>
  ${opts.confirmation.url ? html`<p class="muted">Or open Google's confirmation link: <a href="${opts.confirmation.url}" rel="noreferrer noopener" target="_blank">confirm on google.com</a>. Feedcal never clicks it for you.</p>` : ""}
</div>`
  : ""}
<div class="card">
  <h2>Waiting for you</h2>
  ${nothingWaiting ? html`<p class="muted">Nothing is waiting. New senders and suspicious emails will show up here.</p>` : ""}
  ${opts.senders.map(
    (s) => html`<div style="margin:0 0 1rem">
    <p><strong>Use emails from ${s.sender} for this calendar?</strong><span class="when">${s.count} ${s.count === 1 ? "email" : "emails"} waiting${s.latestSubject ? html`, latest: "<span dir="auto">${s.latestSubject}</span>"` : ""}</span></p>
    <div class="row">
      <form method="post" action="/feeds/${opts.feedId}/senders/${s.sourceId}">${csrf}<input type="hidden" name="decision" value="yes"><button type="submit">Yes, use them</button></form>
      <form method="post" action="/feeds/${opts.feedId}/senders/${s.sourceId}">${csrf}<input type="hidden" name="decision" value="no"><button type="submit" class="secondary">No, ignore this sender</button></form>
    </div>
  </div>`,
  )}
  ${opts.suspicious.map(
    (m) => html`<div style="margin:0 0 1rem">
    <p><strong>This email didn't pass the sender's security checks.</strong><span class="when">From ${m.sender ?? "an unknown sender"} · ${when(m.receivedAt)}${m.subject ? html` · "<span dir="auto">${m.subject}</span>"` : ""}</span></p>
    <p class="muted">It may be forged. Only use it if you expected it.</p>
    <div class="row">
      <form method="post" action="/feeds/${opts.feedId}/messages/${m.id}">${csrf}<input type="hidden" name="decision" value="release"><button type="submit" class="secondary">Use it anyway</button></form>
      <form method="post" action="/feeds/${opts.feedId}/messages/${m.id}">${csrf}<input type="hidden" name="decision" value="ignore"><button type="submit">Ignore it</button></form>
    </div>
  </div>`,
  )}
</div>
<div class="card">
  <h2>How to forward</h2>
  <p class="muted">Menu names change from time to time; if a step doesn't match, look for "Forwarding" or "Rules" in your mail settings.</p>
  <details><summary>Gmail: forward automatically</summary>
    <ol>
      <li>In Gmail on a computer, open Settings (gear) → See all settings → Forwarding and POP/IMAP.</li>
      <li>Choose Add a forwarding address and paste this calendar's address.</li>
      <li>Gmail sends a confirmation code here. It appears on this page within a minute; type it into Gmail.</li>
      <li>Create a filter (search options → "From:" the school's address → Create filter), tick "Forward it to" and pick this address.</li>
    </ol>
    <p class="muted">Only emails matching the filter are forwarded. Your other mail stays private.</p>
  </details>
  <details><summary>Any email app: forward one email</summary>
    <p>Open the email, choose Forward, and send it to this calendar's address. Good for a one-off schedule.</p>
  </details>
  <details><summary>Outlook: forward automatically</summary>
    <ol>
      <li>In Outlook on the web, open Settings → Mail → Rules → Add new rule.</li>
      <li>Condition: From → the school's address. Action: Forward to → this calendar's address.</li>
    </ol>
    <p class="muted">Some work and school accounts block forwarding to outside addresses. If so, forward emails by hand.</p>
  </details>
  <details><summary>Apple Mail: forward automatically</summary>
    <ol>
      <li>On a Mac, open Mail → Settings → Rules → Add Rule.</li>
      <li>If From contains the school's address, Forward Message to this calendar's address.</li>
    </ol>
    <p class="muted">Mac rules only run while Mail is open on that Mac.</p>
  </details>
  <p class="muted">The first email from a new sender waits here until you say yes. Emails over 20 MB or with more than 10 attachments are returned to the sender. Copies are deleted after 30 days.</p>
</div>
${opts.isOwner
  ? html`<div class="card">
  <h2>Getting spam at this address?</h2>
  <p>Get a new address. The old one stops working right away, so you'll need to update your forwarding.</p>
  <form method="post" action="/feeds/${opts.feedId}/rotate-intake">${csrf}<button type="submit" class="danger">Get a new address</button></form>
</div>`
  : ""}
<p><a href="/account">Back to your account</a></p>
${copyScript}`,
  );
}
