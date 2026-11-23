// Notification emails, as plain text and simple HTML. Plain English; every email says why it
// was sent and has a one-click unsubscribe for that kind.
export type Kind = "weekly_digest" | "report" | "stale_nudge" | "milestone" | "supporter_thanks" | "ops_alert" | "gmail_reconnect" | "contact";

/** Operations alerts (D38) go to admins and have no unsubscribe: an ignored alert is the failure. */
export const NO_UNSUBSCRIBE: ReadonlySet<Kind> = new Set<Kind>(["ops_alert", "gmail_reconnect", "contact"]);
const ALERT_TEXT: Record<string, { title: string; check: string }> = {
  queue_backlog: { title: "Emails are waiting in a queue", check: "Open docs/runbooks/queue-backlog.md. Check the Edge Function logs for the named queue." },
  ai_spend_daily: { title: "AI spend is over today's budget", check: "Open docs/runbooks/bad-extraction-wave.md. Look for one feed sending many emails." },
  ai_throttle: { title: "AI work is paused: the month's budget is 80% used", check: "Emails wait until next month or a higher budget. See docs/runbooks/ai-outage.md." },
  email_failures: { title: "Many emails from Calantern are failing", check: "Check the email provider's dashboard for bounces or a suspended key." },
  purge_stuck: { title: "Account deletions are overdue", check: "Open docs/runbooks/purge-stuck.md." },
  abuse_spike: { title: "Many requests are being rate-limited", check: "Open docs/runbooks/spam-wave.md." },
  backup_stale: { title: "No database backup in over 30 hours", check: "Open docs/runbooks/restore.md (\"When backups stop\"). Run the Backup workflow by hand, then check its log." },
};
export interface Rendered { subject: string; text: string; html: string; replyTo?: string }

/** D63: a Reply-To is one plain address, or nothing (it goes into an email header). */
export function safeReplyTo(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 254) return undefined;
  return /^[^\s@<>",;:()[\]\\]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i.test(v) ? v : undefined;
}
const CONTACT_KINDS: Record<string, string> = { bug: "Bug report", question: "Question", privacy: "Privacy request", other: "Message" };

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const REPORT_KINDS: Record<string, string> = {
  wrong_details: "the details are wrong", missing_event: "an event is missing", spam: "it looks like spam", abuse: "it's inappropriate", other: "something needs a look",
};

function when(iso: string, allDay: boolean, tz: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  return allDay ? day : `${day}, ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d)}`;
}

const plural = (n: unknown, one: string, many = `${one}s`) => `${Number(n)} ${Number(n) === 1 ? one : many}`;

/** The steps for leaving a calendar in each calendar app live on the site (apps/web/src/help.ts). */
export const LEAVE_PATH = "/help/unsubscribe";

/** One look for every email people get: the name on top, the message, a quiet footer. */
function shell(bodyHtml: string, footHtml: string): string {
  return `<!doctype html><html><body style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111111;max-width:32rem;margin:0 auto;padding:1.25rem 1rem">
<p style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0 0 1.25rem">Calantern</p>${bodyHtml}
<hr style="border:0;border-top:1px solid #e6e6e6;margin:2rem 0 1rem"><p style="color:#5c5c5c;font-size:14px">${footHtml}</p></body></html>`;
}

function wrap(site: string, unsubscribe: string, why: string, bodyText: string, bodyHtml: string): { text: string; html: string } {
  const leave = `${site}${LEAVE_PATH}`;
  const text = `Hi,\n\n${bodyText}\n\nThanks,\nCalantern\n\n—\nFollowing a calendar on your own phone and don't want it updating by itself any more? Unsubscribe from it in your calendar app. Steps for each app: ${leave}\n\n${why}\nStop these emails: ${unsubscribe}\nAll settings: ${site}/account`;
  const html = shell(`<p>Hi,</p>${bodyHtml}<p>Thanks,<br>Calantern</p>`,
    `Following a calendar on your own phone and don't want it updating by itself any more? Unsubscribe from it in <a href="${esc(leave)}">your calendar app</a>. On an iPhone: Calendar → Calendars → ⓘ next to it → Unsubscribe.<br><br>${esc(why)}<br><a href="${esc(unsubscribe)}">Stop these emails</a> · <a href="${esc(site)}/account">All settings</a>`);
  return { text, html };
}

/** D60: a subject is a single header line. Feed names and event titles come from organizers and
 *  emails, so line breaks and control characters (which could add a header, e.g. a hidden Bcc)
 *  are flattened to spaces. */
export function cleanSubject(subject: string): string {
  return subject.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 250);
}

export function render(kind: Kind, p: Record<string, unknown>, site: string, unsubscribe: string): Rendered {
  const r = renderParts(kind, p, site, unsubscribe);
  return { ...r, subject: cleanSubject(r.subject) };
}

function renderParts(kind: Kind, p: Record<string, unknown>, site: string, unsubscribe: string): Rendered {
  if (kind === "gmail_reconnect") {
    // Unverified Google apps get 7-day connections (D39); this is the one email that keeps checks running.
    const name = String(p.feed_name ?? "your calendar");
    const link = `${site}/feeds/${String(p.feed_id ?? "")}/gmail`;
    const expired = p.expired === true;
    const subject = expired ? `Reconnect Gmail for ${name}` : `Reconnect Gmail for ${name} by tomorrow`;
    const lead = expired
      ? `Calantern can't check Gmail for ${name} any more: Google ended the connection. Until you reconnect, new emails won't reach the calendar.`
      : `Google ends Calantern's Gmail connection for ${name} tomorrow (it lasts 7 days while Calantern is in Google's test mode).`;
    const why = "You get this because you connected Gmail to a Calantern calendar. Disconnecting stops these emails.";
    const body = `Hi,\n\n${lead}\n\nReconnecting takes one click, and your sender and schedule are kept: ${link}\n\nThanks,\nCalantern`;
    const html = shell(`<p>Hi,</p><p>${esc(lead)}</p><p>Reconnecting takes one click, and your sender and schedule are kept.</p><p><a href="${esc(link)}">Reconnect Gmail</a></p><p>Thanks,<br>Calantern</p>`, esc(why));
    return { subject, text: `${body}\n\n—\n${why}`, html };
  }
  if (kind === "contact") {
    const label = CONTACT_KINDS[String(p.kind)] ?? "Message";
    const replyTo = safeReplyTo(p.reply_to);
    const message = String(p.message ?? "");
    const page = typeof p.page === "string" && p.page ? p.page : null;
    const who = replyTo ? `Reply to: ${replyTo} (just reply to this email)` : "No reply address given.";
    const signedIn = p.signed_in === true ? "Sent while signed in." : "Sent while signed out.";
    const subject = `Calantern ${label.toLowerCase()}: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`;
    const text = `${label} from the contact form.\n\n${message}\n\n${page ? `Page: ${page}\n` : ""}${who}\n${signedIn}\n\n—\nYou get this because you're a Calantern admin.`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d1d1b"><p><strong>${esc(label)}</strong> from the contact form.</p><blockquote style="white-space:pre-wrap;border-left:3px solid #e3e3df;margin:0;padding:.5rem 1rem">${esc(message)}</blockquote>${page ? `<p>Page: ${esc(page)}</p>` : ""}<p>${esc(who)}<br>${esc(signedIn)}</p><hr style="border:0;border-top:1px solid #e3e3df;margin:2rem 0 1rem"><p style="color:#4f4f4b;font-size:14px">You get this because you're a Calantern admin.</p></body></html>`;
    return { subject, text, html, ...(replyTo ? { replyTo } : {}) };
  }
  if (kind === "ops_alert") {
    const a = ALERT_TEXT[String(p.kind)] ?? { title: `Alert: ${String(p.kind)}`, check: "See docs/RUNBOOKS.md." };
    const drill = p.drill === true;
    const subject = `${drill ? "[Drill] " : ""}Calantern alert: ${a.title}`;
    const detail = JSON.stringify(p.detail ?? {});
    const body = `${drill ? "This is a drill. Nothing is wrong.\n\n" : ""}${a.title}.\n\nDetails: ${detail}\n\nWhat to do: ${a.check}\n\nOperations panel: ${site}/admin`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d1d1b">${drill ? "<p><strong>This is a drill. Nothing is wrong.</strong></p>" : ""}<p><strong>${esc(a.title)}.</strong></p><p>Details: <code>${esc(detail)}</code></p><p>What to do: ${esc(a.check)}</p><p><a href="${esc(site)}/admin">Operations panel</a></p><hr style="border:0;border-top:1px solid #e3e3df;margin:2rem 0 1rem"><p style="color:#4f4f4b;font-size:14px">You get this because you're a Calantern admin.</p></body></html>`;
    return { subject, text: `${body}\n\n—\nYou get this because you're a Calantern admin.`, html };
  }
  if (kind === "report") {
    const what = REPORT_KINDS[String(p.kind)] ?? "something needs a look";
    const subject = `Someone spotted a problem with "${p.event_title}"`;
    const link = `${site}/feeds/${p.feed_id}/events/${p.event_id}`;
    const whenText = when(String(p.starts_at), Boolean(p.all_day), String(p.timezone));
    const body = `Someone following ${p.feed_name} says ${what}:\n\n${p.event_title} (${whenText})${p.details ? `\n\n"${p.details}"` : ""}\n\nTake a quick look, and fix it if it needs fixing: ${link}\n\nIf it's fine as it is, there's nothing to do.`;
    const html = `<p>Someone following <strong>${esc(p.feed_name)}</strong> says ${esc(what)}:</p><p><strong>${esc(p.event_title)}</strong><br>${esc(whenText)}</p>${p.details ? `<blockquote style="border-left:4px solid #e6e6e6;margin:0 0 1rem;padding-left:.75rem">${esc(p.details)}</blockquote>` : ""}<p><a href="${esc(link)}">Take a quick look</a>, and fix it if it needs fixing. If it's fine as it is, there's nothing to do.</p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this because you run this calendar and asked to hear about reports right away.", body, html) };
  }
  if (kind === "supporter_thanks") {
    const subject = "Thank you for supporting Calantern";
    const body = `Thank you, truly. Your support keeps Calantern free for schools, teams and families.\n\nYour account now shows a supporter badge. If you'd like your name on the supporters page, you can choose that here: ${site}/account`;
    const html = `<p>Thank you, truly. Your support keeps Calantern free for schools, teams and families.</p><p>Your account now shows a supporter badge. If you'd like your name on the supporters page, <a href="${esc(site)}/account">you can choose that here</a>.</p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this once, because you linked your Buy Me a Coffee support to your account.", body, html) };
  }
  if (kind === "stale_nudge") {
    const link = `${site}/feeds/${p.feed_id}`;
    const subject = `${p.feed_name} has been quiet for ${p.days} days`;
    const body = `${p.feed_name} hasn't had anything new in ${p.days} days, and nothing is coming up. People following it will see an empty calendar.\n\nGot a new email from the school or team? Send it over, or add an event yourself: ${link}\n\nNothing happening right now? That's fine, you can ignore this. After 90 days without updates, the calendar's page says it may be out of date.`;
    const html = `<p><strong>${esc(p.feed_name)}</strong> hasn't had anything new in ${esc(p.days)} days, and nothing is coming up. People following it will see an empty calendar.</p><p>Got a new email from the school or team? Send it over, or <a href="${esc(link)}">add an event yourself</a>.</p><p style="color:#5c5c5c">Nothing happening right now? That's fine, you can ignore this. After 90 days without updates, the calendar's page says it may be out of date.</p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this once each time a calendar you own goes quiet.", body, html) };
  }
  if (kind === "milestone") {
    // The count is a rough estimate (D52/D53), so the email is a thank-you, not a number.
    const link = `${site}/feeds/${p.feed_id}/milestones/${p.milestone}`;
    const subject = `${p.feed_name} is helping a lot of families`;
    const body = `Thank you for keeping ${p.feed_name} going. Every family that follows it is one that doesn't have to copy dates by hand.\n\nOur best guess is that around ${p.milestone} calendars follow it now. It's only a guess: the real number is hard to measure.\n\nA thank-you card to share: ${link}`;
    const html = `<p>Thank you for keeping <strong>${esc(p.feed_name)}</strong> going. Every family that follows it is one that doesn't have to copy dates by hand.</p><p style="color:#5c5c5c">Our best guess is that around ${esc(p.milestone)} calendars follow it now. It's only a guess: the real number is hard to measure.</p><p><a href="${esc(link)}">See the thank-you card</a></p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this when a calendar you own reaches about 10, 50 or 100 followers.", body, html) };
  }
  // weekly_digest: what needs the organizer first; the follower estimate last and small.
  const feeds = (p.feeds as Record<string, number | string>[] | undefined) ?? [];
  const review = feeds.reduce((n, f) => n + Number(f.needs_review), 0);
  const subject = review > 0 ? `Your Calantern week: ${review} to review` : "Your Calantern week";
  const waiting = (f: Record<string, number | string>) => (Number(f.needs_review) > 0 ? `${plural(f.needs_review, "event")} waiting for your OK` : "Nothing waiting for you");
  const added = (f: Record<string, number | string>) => `${plural(f.events_added, "new event")} this week${Number(f.reports) > 0 ? `, ${plural(f.reports, "problem report")}` : ""}`;
  const guess = (f: Record<string, number | string>) => (Number(f.subscribers) > 0 ? `Roughly ${plural(f.subscribers, "calendar follows", "calendars follow")} it (a rough guess).` : "");
  const intro = review > 0 ? `Here's your week. ${plural(review, "event needs", "events need")} a quick look from you.` : "Here's your week. Nothing needs you right now.";
  const lines = feeds.map((f) => `${f.name}\n  ${waiting(f)}.\n  ${added(f)}.\n  Open it: ${site}/feeds/${f.id}${guess(f) ? `\n  ${guess(f)}` : ""}`);
  const body = `${intro}\n\n${lines.join("\n\n") || `You don't have a calendar yet. Make one: ${site}/feeds/new`}`;
  const html = `<p>${esc(intro)}</p>${feeds.map((f) => `<p><a href="${esc(site)}/feeds/${esc(f.id)}"><strong>${esc(f.name)}</strong></a><br>${Number(f.needs_review) > 0 ? `<strong>${esc(waiting(f))}</strong>` : esc(waiting(f))} · ${esc(added(f))}${guess(f) ? `<br><span style="color:#5c5c5c;font-size:14px">${esc(guess(f))}</span>` : ""}</p>`).join("") || `<p>You don't have a calendar yet. <a href="${esc(site)}/feeds/new">Make one</a>.</p>`}`;
  return { subject, ...wrap(site, unsubscribe, "You get this every Monday because you run a Calantern calendar.", body, html) };
}
