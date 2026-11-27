// Notification emails, as plain text and simple HTML. Plain English; every email says why it
// was sent and has a one-click unsubscribe for that kind.
export type Kind = "weekly_digest" | "report" | "stale_nudge" | "milestone" | "supporter_thanks" | "ops_alert" | "gmail_reconnect" | "contact" | "events_published";

/** Operations alerts (D38) go to admins and have no unsubscribe: an ignored alert is the failure. */
export const NO_UNSUBSCRIBE: ReadonlySet<Kind> = new Set<Kind>(["ops_alert", "gmail_reconnect", "contact"]);
const ALERT_TEXT: Record<string, { title: string; check: string }> = {
  queue_backlog: { title: "Emails are waiting in a queue", check: "Open docs/runbooks/queue-backlog.md. Check the Edge Function logs for the named queue." },
  ai_spend_daily: { title: "AI spend is over today's budget", check: "Open docs/runbooks/bad-extraction-wave.md. Look for one feed sending many emails." },
  ai_throttle: { title: "AI work is paused: the month's budget is 80% used", check: "Emails wait until next month or a higher budget. See docs/runbooks/ai-outage.md." },
  email_failures: { title: "Many emails from Bumpdraft are failing", check: "Check the email provider's dashboard for bounces or a suspended key." },
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

interface DigestItem { title: string; starts_at?: string; all_day?: boolean; timezone?: string; reasons?: string[]; outcome?: string | null; change_kind?: string | null }
interface DigestQuestion { body: string; event_title: string; starts_at?: string; all_day?: boolean; timezone?: string }
interface DigestFeed { id: string; name: string; subscribers: number; events_added: number; needs_review: number; reports: number; open_questions?: number; items?: DigestItem[]; questions?: DigestQuestion[] }

/** D91: one short line on why an item is waiting. The Review page says the same in more words. */
const ITEM_WHY: Record<string, string> = {
  possible_injection: "The email has text aimed at the AI. Check it carefully.",
  ambiguous_date: "The wording fits more than one date.",
  date_mismatch: "The date doesn't match what the email says.",
  weekday_mismatch: "The weekday and the date in the email don't agree.",
  time_mismatch: "The time doesn't match the time written in the email.",
  time_unlikely: "The time has no AM or PM, and this is the less usual reading.",
  before_email: "The date is before the email was sent.",
  from_transcription: "Read from a picture.",
};
function itemWhy(i: DigestItem): string {
  const reasons = i.reasons ?? [];
  for (const [r, why] of Object.entries(ITEM_WHY)) if (reasons.includes(r)) return why;
  if (i.outcome === "conflict") return "Bumpdraft read the email again and got a different time.";
  if (i.outcome === "update" || i.outcome === "cancel" || i.outcome === "exdate") return "It changes something already on your calendar.";
  return "Bumpdraft wasn't sure enough to add it by itself.";
}
const itemVerb = (i: DigestItem) => (i.change_kind === "cancelled" ? "Cancel: " : i.outcome === "update" || i.outcome === "conflict" ? "Change: " : "");

/** The steps for leaving a calendar in each calendar app live on the site (apps/web/src/help.ts). */
export const LEAVE_PATH = "/help/unsubscribe";

/** One look for every email people get: the name on top, the message, a quiet footer. */
function shell(bodyHtml: string, footHtml: string): string {
  return `<!doctype html><html><body style="font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111111;max-width:32rem;margin:0 auto;padding:1.25rem 1rem">
<p style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0 0 1.25rem">Bumpdraft</p>${bodyHtml}
<hr style="border:0;border-top:1px solid #e6e6e6;margin:2rem 0 1rem"><p style="color:#5c5c5c;font-size:14px">${footHtml}</p></body></html>`;
}

function wrap(site: string, unsubscribe: string, why: string, bodyText: string, bodyHtml: string): { text: string; html: string } {
  const leave = `${site}${LEAVE_PATH}`;
  const text = `Hi,\n\n${bodyText}\n\nThanks,\nBumpdraft\n\n—\nFollowing a calendar on your own phone and don't want it updating by itself any more? Unsubscribe from it in your calendar app. Steps for each app: ${leave}\n\n${why}\nStop these emails: ${unsubscribe}\nAll settings: ${site}/account`;
  const html = shell(`<p>Hi,</p>${bodyHtml}<p>Thanks,<br>Bumpdraft</p>`,
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
    // D86: sent every 20 days while the connection stays lapsed.
    const days = typeof p.days_lapsed === "number" && p.days_lapsed >= 20 ? Math.floor(p.days_lapsed) : 0;
    const subject = days ? `Gmail for ${name} has been disconnected for ${days} days` : expired ? `Reconnect Gmail for ${name}` : `Reconnect Gmail for ${name} by tomorrow`;
    const lead = days
      ? `Bumpdraft hasn't been able to check Gmail for ${name} for ${days} days. New emails are not reaching the calendar, and the calendar now tells its followers that it may be missing newer events.`
      : expired
      ? `Bumpdraft can't check Gmail for ${name} any more: Google ended the connection. Until you reconnect, new emails won't reach the calendar.`
      : `Google ends Bumpdraft's Gmail connection for ${name} tomorrow (it lasts 7 days while Bumpdraft is in Google's test mode).`;
    const why = "You get this because you connected Gmail to a Bumpdraft calendar. Disconnecting stops these emails.";
    const body = `Hi,\n\n${lead}\n\nReconnecting takes one click, and your sender and schedule are kept: ${link}\n\nThanks,\nBumpdraft`;
    const html = shell(`<p>Hi,</p><p>${esc(lead)}</p><p>Reconnecting takes one click, and your sender and schedule are kept.</p><p><a href="${esc(link)}">Reconnect Gmail</a></p><p>Thanks,<br>Bumpdraft</p>`, esc(why));
    return { subject, text: `${body}\n\n—\n${why}`, html };
  }
  if (kind === "events_published") {
    // D77: every automatic change reaches a person at once, with the words it was read from.
    const feedId = String(p.feed_id ?? "");
    const name = String(p.feed_name ?? "your calendar");
    const from = typeof p.subject === "string" && p.subject ? `"${p.subject}"` : "an email";
    const items = (Array.isArray(p.items) ? p.items : []).slice(0, 20) as Record<string, unknown>[];
    const VERB: Record<string, string> = { added: "Added", changed: "Changed", cancelled: "Cancelled" };
    const line = (i: Record<string, unknown>) => {
      const date = when(String(i.starts_at ?? ""), i.all_day === true, String(i.timezone ?? "UTC"));
      return { verb: VERB[String(i.what)] ?? "Added", title: String(i.title ?? "Event"), date, quote: String(i.quote ?? ""),
        picture: i.picture === true, link: `${site}/feeds/${feedId}/events/${String(i.event_id ?? "")}` };
    };
    const lines = items.map(line);
    const n = lines.length;
    const subject = `${name}: ${n === 1 ? `${lines[0]!.verb.toLowerCase()} "${lines[0]!.title}"` : `${n} calendar changes`} from ${from}`;
    const lead = `Bumpdraft read ${from} and updated ${name} without asking you. Please check ${n === 1 ? "it" : "them"} against the email. If anything is wrong, open it to fix or remove it; followers' calendars update on their own.`;
    const text = lines.map((l) => `${l.verb}: ${l.title}\n  ${l.date}\n  Read from${l.picture ? " a picture" : ""}: "${l.quote}"\n  Fix or remove: ${l.link}`).join("\n\n");
    const html = lines.map((l) => `<p><strong>${esc(l.verb)}: ${esc(l.title)}</strong><br>${esc(l.date)}<br><span style="color:#5c5c5c">Read from${l.picture ? " a picture" : ""}: “${esc(l.quote)}”</span><br><a href="${esc(l.link)}">Fix or remove</a></p>`).join("");
    const w = wrap(site, unsubscribe, "You get this because Bumpdraft changed a calendar you own without asking first.", `${lead}\n\n${text}`, `<p>${esc(lead)}</p>${html}`);
    return { subject, ...w };
  }
  if (kind === "contact") {
    const label = CONTACT_KINDS[String(p.kind)] ?? "Message";
    const replyTo = safeReplyTo(p.reply_to);
    const message = String(p.message ?? "");
    const page = typeof p.page === "string" && p.page ? p.page : null;
    const who = replyTo ? `Reply to: ${replyTo} (just reply to this email)` : "No reply address given.";
    const signedIn = p.signed_in === true ? "Sent while signed in." : "Sent while signed out.";
    const subject = `Bumpdraft ${label.toLowerCase()}: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`;
    const text = `${label} from the contact form.\n\n${message}\n\n${page ? `Page: ${page}\n` : ""}${who}\n${signedIn}\n\n—\nYou get this because you're a Bumpdraft admin.`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d1d1b"><p><strong>${esc(label)}</strong> from the contact form.</p><blockquote style="white-space:pre-wrap;border-left:3px solid #e3e3df;margin:0;padding:.5rem 1rem">${esc(message)}</blockquote>${page ? `<p>Page: ${esc(page)}</p>` : ""}<p>${esc(who)}<br>${esc(signedIn)}</p><hr style="border:0;border-top:1px solid #e3e3df;margin:2rem 0 1rem"><p style="color:#4f4f4b;font-size:14px">You get this because you're a Bumpdraft admin.</p></body></html>`;
    return { subject, text, html, ...(replyTo ? { replyTo } : {}) };
  }
  if (kind === "ops_alert") {
    const a = ALERT_TEXT[String(p.kind)] ?? { title: `Alert: ${String(p.kind)}`, check: "See docs/RUNBOOKS.md." };
    const drill = p.drill === true;
    const subject = `${drill ? "[Drill] " : ""}Bumpdraft alert: ${a.title}`;
    const detail = JSON.stringify(p.detail ?? {});
    const body = `${drill ? "This is a drill. Nothing is wrong.\n\n" : ""}${a.title}.\n\nDetails: ${detail}\n\nWhat to do: ${a.check}\n\nOperations panel: ${site}/admin`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d1d1b">${drill ? "<p><strong>This is a drill. Nothing is wrong.</strong></p>" : ""}<p><strong>${esc(a.title)}.</strong></p><p>Details: <code>${esc(detail)}</code></p><p>What to do: ${esc(a.check)}</p><p><a href="${esc(site)}/admin">Operations panel</a></p><hr style="border:0;border-top:1px solid #e3e3df;margin:2rem 0 1rem"><p style="color:#4f4f4b;font-size:14px">You get this because you're a Bumpdraft admin.</p></body></html>`;
    return { subject, text: `${body}\n\n—\nYou get this because you're a Bumpdraft admin.`, html };
  }
  if (kind === "report" && p.question === true) {
    // D88: an anonymous question about an event, sent under the same setting as reports.
    const subject = `A follower asked about "${p.event_title}"`;
    const link = `${site}/feeds/${p.feed_id}`;
    const whenText = when(String(p.starts_at), Boolean(p.all_day), String(p.timezone));
    const body = `Someone following ${p.feed_name} asked about:\n\n${p.event_title} (${whenText})\n\n"${p.details}"\n\nOnly you can see the question. If you answer it, the question and your answer show on that event's question page for all followers: ${link}\n\nIf it isn't a real question, you can hide it there.`;
    const html = `<p>Someone following <strong>${esc(p.feed_name)}</strong> asked about:</p><p><strong>${esc(p.event_title)}</strong><br>${esc(whenText)}</p><blockquote style="border-left:4px solid #e6e6e6;margin:0 0 1rem;padding-left:.75rem">${esc(p.details)}</blockquote><p>Only you can see the question. If you answer it, the question and your answer show on that event's question page for all followers.</p><p><a href="${esc(link)}">Answer it</a></p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this because you run this calendar and asked to hear about reports right away.", body, html) };
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
    const subject = "Thank you for supporting Bumpdraft";
    const body = `Thank you, truly. Your support keeps Bumpdraft free for schools, teams and families.\n\nYour account now shows a supporter badge. If you'd like your name on the supporters page, you can choose that here: ${site}/account`;
    const html = `<p>Thank you, truly. Your support keeps Bumpdraft free for schools, teams and families.</p><p>Your account now shows a supporter badge. If you'd like your name on the supporters page, <a href="${esc(site)}/account">you can choose that here</a>.</p>`;
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
  // weekly_digest (D91): what needs the organizer, item by item; the follower estimate last and small.
  const feeds = (p.feeds as DigestFeed[] | undefined) ?? [];
  const review = feeds.reduce((n, f) => n + Number(f.needs_review), 0);
  const asked = feeds.reduce((n, f) => n + Number(f.open_questions ?? 0), 0);
  const parts = [review > 0 ? `${review} to review` : "", asked > 0 ? plural(asked, "question") : ""].filter(Boolean);
  const subject = parts.length ? `Needs you this week: ${parts.join(", ")}` : "Your Bumpdraft week";
  const added = (f: DigestFeed) => `${plural(f.events_added, "new event")} this week${Number(f.reports) > 0 ? `, ${plural(f.reports, "problem report")}` : ""}`;
  const guess = (f: DigestFeed) => (Number(f.subscribers) > 0 ? `Roughly ${plural(f.subscribers, "calendar follows", "calendars follow")} it (a rough guess).` : "");
  const needs = [review > 0 ? plural(review, "event") : "", asked > 0 ? plural(asked, "follower question") : ""].filter(Boolean).join(" and ");
  const intro = needs ? `Here's what needs you this week: ${needs}. Nothing below goes on a calendar until you say so.` : "Here's your week. Nothing needs you right now.";
  const itemWhen = (i: { starts_at?: string; all_day?: boolean; timezone?: string }) => { try { return when(String(i.starts_at), Boolean(i.all_day), String(i.timezone)); } catch { return ""; } };
  const more = (total: unknown, shown: number, one: string, many: string) => (Number(total) > shown ? `and ${Number(total) - shown} more ${Number(total) - shown === 1 ? one : many}` : "");
  const blocks = feeds.map((f) => {
    const items = f.items ?? [], qs = f.questions ?? [];
    const link = `${site}/feeds/${f.id}`;
    const moreItems = f.items ? more(f.needs_review, items.length, "event", "events") : "";
    const moreQs = f.questions ? more(f.open_questions ?? 0, qs.length, "question", "questions") : "";
    const waiting = Number(f.needs_review) > 0 ? `${plural(f.needs_review, "event")} waiting for your OK` : "Nothing waiting for you";
    const t: string[] = [`${f.name}`, `  ${waiting}.`];
    for (const i of items) t.push(`  - ${itemVerb(i)}${i.title} (${itemWhen(i)})\n    ${itemWhy(i)}`);
    if (moreItems) t.push(`  ${moreItems}.`);
    if (Number(f.open_questions ?? 0) > 0) t.push(`  ${plural(f.open_questions, "follower question")} waiting for an answer.`);
    for (const q of qs) t.push(`  - About ${q.event_title} (${itemWhen(q)}): "${q.body}"`);
    if (moreQs) t.push(`  ${moreQs}.`);
    t.push(`  ${added(f)}.`, `  ${Number(f.needs_review) + Number(f.open_questions ?? 0) > 0 ? "Go through them" : "Open it"}: ${link}`);
    if (guess(f)) t.push(`  ${guess(f)}`);
    const li = (inner: string) => `<li style="margin:0 0 .6rem">${inner}</li>`;
    const h = `<p style="margin:1.5rem 0 .25rem"><a href="${esc(link)}"><strong>${esc(f.name)}</strong></a><br>${Number(f.needs_review) > 0 ? `<strong>${esc(waiting)}</strong>` : esc(waiting)} · ${esc(added(f))}</p>`
      + (items.length ? `<ul style="padding-left:1.1rem;margin:.5rem 0">${items.map((i) => li(`${esc(itemVerb(i))}<strong>${esc(i.title)}</strong> · ${esc(itemWhen(i))}<br><span style="color:#5c5c5c;font-size:14px">${esc(itemWhy(i))}</span>`)).join("")}${moreItems ? li(esc(`${moreItems}.`)) : ""}</ul>` : "")
      + (Number(f.open_questions ?? 0) > 0 ? `<p style="margin:.75rem 0 .25rem"><strong>${esc(plural(f.open_questions, "follower question"))} waiting for an answer</strong></p><ul style="padding-left:1.1rem;margin:.5rem 0">${qs.map((q) => li(`About <strong>${esc(q.event_title)}</strong> · ${esc(itemWhen(q))}<br>“${esc(q.body)}”`)).join("")}${moreQs ? li(esc(`${moreQs}.`)) : ""}</ul>` : "")
      + (Number(f.needs_review) + Number(f.open_questions ?? 0) > 0 ? `<p><a href="${esc(link)}" style="display:inline-block;background:#111111;color:#ffffff;padding:.55rem .9rem;border-radius:8px;text-decoration:none">Go through them</a></p>` : "")
      + (guess(f) ? `<p style="color:#5c5c5c;font-size:14px">${esc(guess(f))}</p>` : "");
    return { text: t.join("\n"), html: h };
  });
  const body = `${intro}\n\n${blocks.map((b) => b.text).join("\n\n") || `You don't have a calendar yet. Make one: ${site}/feeds/new`}`;
  const html = `<p>${esc(intro)}</p>${blocks.map((b) => b.html).join("") || `<p>You don't have a calendar yet. <a href="${esc(site)}/feeds/new">Make one</a>.</p>`}`;
  return { subject, ...wrap(site, unsubscribe, "You get this every Monday because you run a Bumpdraft calendar.", body, html) };
}
