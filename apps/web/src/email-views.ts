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
  <h2>Confirm Gmail forwarding</h2>
  <p>Gmail asked to confirm forwarding${opts.confirmation.requestedBy ? html` from <strong>${opts.confirmation.requestedBy}</strong>` : ""}. Only continue if that's you or someone you trust.</p>
  ${opts.confirmation.url
    ? html`<p><a class="button" href="${opts.confirmation.url}" rel="noreferrer noopener" target="_blank">Confirm on google.com</a></p>
  <p class="muted">Then go back to Gmail's settings page and refresh it. Feedcal never clicks this link for you.</p>`
    : ""}
  <p class="muted">Confirmation code, if Gmail asks for one: <strong style="font-size:1.25rem;letter-spacing:.1em">${opts.confirmation.code}</strong></p>
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
      <li>In Gmail on a computer, open Settings (gear) → See all settings → the Forwarding and POP/IMAP (or Forwarding) tab.</li>
      <li>Click Add a forwarding address, paste this calendar's address, then Next → Proceed → OK.</li>
      <li>Gmail sends a confirmation here. Within a minute a "Confirm on google.com" button appears on this page. Click it, then refresh Gmail's settings page.</li>
      <li><strong>Leave "Forward a copy of incoming mail" off.</strong> Instead, in Gmail's search box open Show search options, put the school's address in From, click Create filter, tick Forward it, choose this calendar's address, and click Create filter.</li>
    </ol>
    <p class="muted">Only emails matching the filter are forwarded. Your other mail stays private.</p>
  </details>
  <details><summary>Any email app: forward one email</summary>
    <p>Open the email, choose Forward, and send it to this calendar's address. Good for a one-off schedule.</p>
  </details>
  <details><summary>Outlook: forward automatically</summary>
    <ol>
      <li>In Outlook.com, Outlook on the web or the new Outlook, open Settings → Mail → Rules → Add rule.</li>
      <li>Condition: From → the school's address. Action: Forward to → this calendar's address. Save.</li>
    </ol>
    <p class="muted">Outlook sends these as forwarded by you, so Feedcal will ask once whether to use emails from your own address. Some work and school accounts block forwarding to outside addresses; if so, forward emails by hand.</p>
  </details>
  <details><summary>iCloud Mail: forward automatically</summary>
    <ol>
      <li>On iCloud.com, open Mail, select the Settings button at the top of the mailbox list, then Settings → Rules → Add.</li>
      <li>Name the rule, set it to match messages from the school's address, choose the forward action with this calendar's address, then Add.</li>
    </ol>
    <p class="muted">iCloud rules run on Apple's servers, so they work even when your devices are off.</p>
  </details>
  <details><summary>Apple Mail on a Mac: forward automatically</summary>
    <ol>
      <li>Open Mail → Settings → Rules → Add Rule.</li>
      <li>If From contains the school's address, Forward Message to this calendar's address.</li>
    </ol>
    <p class="muted">Mac rules only run while Mail is open on that Mac. For iCloud addresses, the iCloud Mail rule above is more reliable.</p>
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
