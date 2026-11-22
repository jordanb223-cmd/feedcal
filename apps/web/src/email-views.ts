import { html } from "hono/html";
import { feedNav } from "./nav.js";
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

export interface RecentAttachment {
  id: string;
  filename: string | null;
  mime: string | null;
  status: string;
  chosen: boolean;
  reason: string | null;
  keptPages: number[];
  pages: number | null;
  thumbnailUrl: string | null;
}
export interface RecentEmail {
  id: string;
  sourceId: string | null;
  subject: string | null;
  sender: string | null;
  receivedAt: string;
  status: string;
  pagesForAi: number | null;
  attachments: RecentAttachment[];
}

const pageList = (pages: number[]) => {
  const n = pages.map((p) => p + 1);
  return n.length === 1 ? `page ${n[0]}` : `pages ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};

/** What happened to a file, in plain words. Unknown reasons fall back to the status. */
export function attachmentOutcome(a: RecentAttachment): string {
  switch (a.reason) {
    case "text_layer": return a.keptPages.length ? `Reading ${pageList(a.keptPages)}${a.pages ? ` of ${a.pages}` : ""}` : "Read";
    case "transcribed": return "Read from the image";
    case "needs_vision_not_configured": return "Waiting: reading images and scans isn't switched on yet";
    case "daily_vision_limit": case "daily_page_limit": return "Waiting: today's reading limit was reached";
    case "no_schedule_found": return "No dates found in it";
    case "rule_other": return "Skipped: you picked a different file from this sender";
    case "rule_never": case "owner_never": return "Skipped: you said never to use files like this";
    case "too_large": return "Skipped: over 15 MB";
    case "too_many_pages": return `Skipped: over 40 pages${a.pages ? ` (${a.pages})` : ""}`;
    case "unlikely_filename": return "Skipped: looks like a receipt or form";
    case "seen_before": return "Skipped: already read in an earlier email";
    case "unsupported_type": return "Skipped: Calantern can't read this kind of file yet";
    case "page_budget_used": return "Skipped: this email already has 5 pages to read";
    case "too_large_for_vision": return "Skipped: image too large to read";
    case "vision_refused": case "vision_failed": case "unreadable": return "Couldn't read this file";
    case "no_text_on_page": return "No text found on it";
    default: return a.status === "pending" ? "Waiting to be read" : a.status;
  }
}

export const EMAIL_NOTICES = {
  approved: "Done. Emails from that sender will now be read for events.",
  declined: "Done. Emails from that sender will be ignored.",
  released: "Done. That email will be read for events.",
  ignored: "Done. That email was ignored.",
  rotated: "Your calendar has a new email address. The old one no longer works, so update any forwarding rules.",
  created: "Your feed is ready. Forward emails to the address below, or add events by hand from the feed's page.",
  created_public_later: "Your feed is ready, and private for now: a calendar can be listed publicly once it has a published event (and your account is 7 days old). Add events, then switch it to Public in Settings.",
  chosen: "Got it. Calantern will read that file, and will pick files like it from this sender from now on.",
  never: "Got it. Calantern will skip files like that from this sender.",
  large: "Got it. Big attachments from this sender will be read.",
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
  recent?: RecentEmail[];
  notice?: EmailNotice;
}): Html {
  const csrf = html`<input type="hidden" name="csrf" value="${opts.csrf}">`;
  const nothingWaiting = opts.senders.length === 0 && opts.suspicious.length === 0;
  return layout(
    `Email for ${opts.name}`,
    html`<div class="card">
  ${feedNav(opts.feedId, "email")}
  <h1>Email for <span dir="auto">${opts.name}</span></h1>
  ${opts.notice ? html`<p role="status">${EMAIL_NOTICES[opts.notice]}</p>` : ""}
  <p>Forward school or team emails to this address. Calantern reads them and finds the events.</p>
  ${opts.address
    ? html`<p><label for="intake">This calendar's email address</label><input class="copy" id="intake" readonly spellcheck="false" value="${opts.address}"></p>
  <p><button type="button" class="secondary" data-copy="intake">Copy address</button></p>`
    : html`<p class="error" role="alert">Email forwarding isn't switched on for this site yet, so this address doesn't receive mail. Your calendar's address will be <code>${opts.localPart}@…</code> once it is.</p>`}
</div>
${opts.confirmation
  ? html`<div class="card">
  <h2>Confirm Gmail forwarding</h2>
  <p>Gmail asked to confirm forwarding${opts.confirmation.requestedBy ? html` from <strong>${opts.confirmation.requestedBy}</strong>` : ""}. Only continue if that's you or someone you trust.</p>
  ${opts.confirmation.url
    ? html`<p><a class="button" href="${opts.confirmation.url}" rel="noreferrer noopener" target="_blank">Confirm on google.com</a></p>
  <p class="muted">Then go back to Gmail's settings page and refresh it. Calantern never clicks this link for you.</p>`
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
    <p class="muted" style="font-size:.875rem">${SENDER_NOTE}</p>
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
  <h2>Recent emails</h2>
  ${!opts.recent?.length
    ? html`<p class="muted">No emails yet. Once you forward one, you'll see here what Calantern read from it.</p>`
    : opts.recent.map(
      (m) => html`<div style="margin:0 0 1.25rem">
    <p><strong dir="auto">${m.subject ?? "(no subject)"}</strong><span class="when">${m.sender ?? "unknown sender"} · ${when(m.receivedAt)}</span></p>
    ${m.attachments.length === 0
      ? html`<p class="muted">No attachments; the email text is read.</p>`
      : html`<ul class="events">${m.attachments.map(
        (a) => html`<li>
      ${a.thumbnailUrl ? html`<img src="${a.thumbnailUrl}" alt="" width="64" height="64" style="object-fit:cover;border-radius:6px;float:right;margin-left:.5rem">` : ""}
      <strong dir="auto">${a.filename ?? "(unnamed file)"}</strong>${a.chosen ? html` <span class="muted">(your pick)</span>` : ""}
      <span class="when">${attachmentOutcome(a)}</span>
      <div class="row" style="margin-top:.5rem">
        ${a.chosen ? "" : html`<form method="post" action="/feeds/${opts.feedId}/attachments/${a.id}/choose">${csrf}<button type="submit" class="secondary">This one has the schedule</button></form>`}
        ${a.reason === "owner_never" || a.reason === "rule_never" ? "" : html`<form method="post" action="/feeds/${opts.feedId}/attachments/${a.id}/never">${csrf}<button type="submit" class="secondary">Never use files like this</button></form>`}
        ${(a.reason === "too_large" || a.reason === "too_many_pages") && m.sourceId
          ? html`<form method="post" action="/feeds/${opts.feedId}/senders/${m.sourceId}/large">${csrf}<button type="submit" class="secondary">Read big files from this sender</button></form>`
          : ""}
      </div></li>`,
      )}</ul>`}
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
    <p class="muted">Outlook sends these as forwarded by you, so Calantern will ask once whether to use emails from your own address. Some work and school accounts block forwarding to outside addresses; if so, forward emails by hand.</p>
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
  <form method="post" action="/feeds/${opts.feedId}/rotate-intake">${csrf}
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand the old address stops working right away</label></p>
    <button type="submit" class="danger">Get a new address</button></form>
</div>`
  : ""}
<p><a href="/account">Back to your account</a></p>`,
  );
}

// D44/D41: what approving a sender means, said before the owner clicks.
export const SENDER_NOTE = "If you say yes, events from this sender go on the calendar without asking you when the email clearly states the date. Anything unclear waits here for your OK.";
