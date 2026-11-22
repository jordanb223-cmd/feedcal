// Notification emails, as plain text and simple HTML. Plain English; every email says why it
// was sent and has a one-click unsubscribe for that kind.
export type Kind = "weekly_digest" | "report" | "stale_nudge" | "milestone" | "supporter_thanks" | "ops_alert" | "gmail_reconnect";

/** Operations alerts (D38) go to admins and have no unsubscribe: an ignored alert is the failure. */
export const NO_UNSUBSCRIBE: ReadonlySet<Kind> = new Set<Kind>(["ops_alert", "gmail_reconnect"]);
const ALERT_TEXT: Record<string, { title: string; check: string }> = {
  queue_backlog: { title: "Emails are waiting in a queue", check: "Open docs/runbooks/queue-backlog.md. Check the Edge Function logs for the named queue." },
  ai_spend_daily: { title: "AI spend is over today's budget", check: "Open docs/runbooks/bad-extraction-wave.md. Look for one feed sending many emails." },
  ai_throttle: { title: "AI work is paused: the month's budget is 80% used", check: "Emails wait until next month or a higher budget. See docs/runbooks/ai-outage.md." },
  email_failures: { title: "Many emails from Calantern are failing", check: "Check the email provider's dashboard for bounces or a suspended key." },
  purge_stuck: { title: "Account deletions are overdue", check: "Open docs/runbooks/purge-stuck.md." },
  abuse_spike: { title: "Many requests are being rate-limited", check: "Open docs/runbooks/spam-wave.md." },
};
export interface Rendered { subject: string; text: string; html: string }

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const REPORT_KINDS: Record<string, string> = {
  wrong_details: "the details are wrong", missing_event: "an event is missing", spam: "it looks like spam", abuse: "it's inappropriate", other: "something else",
};

function when(iso: string, allDay: boolean, tz: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  return allDay ? day : `${day}, ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d)}`;
}

function wrap(site: string, unsubscribe: string, why: string, bodyText: string, bodyHtml: string): { text: string; html: string } {
  const text = `${bodyText}\n\n—\n${why}\nStop these emails: ${unsubscribe}\nAll settings: ${site}/account`;
  const html = `<!doctype html><html><body style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1b;max-width:32rem;margin:0 auto;padding:1rem">${bodyHtml}
<hr style="border:0;border-top:1px solid #e3e3df;margin:2rem 0 1rem"><p style="color:#4f4f4b;font-size:14px">${esc(why)}<br><a href="${esc(unsubscribe)}">Stop these emails</a> · <a href="${esc(site)}/account">All settings</a></p></body></html>`;
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
    const body = `${lead}\n\nReconnecting takes one click and keeps your sender and schedule: ${link}`;
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d1d1b"><p>${esc(lead)}</p><p>Reconnecting takes one click and keeps your sender and schedule.</p><p><a href="${esc(link)}">Reconnect Gmail</a></p><hr style="border:0;border-top:1px solid #e3e3df;margin:2rem 0 1rem"><p style="color:#4f4f4b;font-size:14px">You get this because you connected Gmail to a Calantern calendar. Disconnecting stops these emails.</p></body></html>`;
    return { subject, text: `${body}\n\n—\nYou get this because you connected Gmail to a Calantern calendar.`, html };
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
    const what = REPORT_KINDS[String(p.kind)] ?? "something";
    const subject = `Someone reported a problem with "${p.event_title}"`;
    const link = `${site}/feeds/${p.feed_id}/events/${p.event_id}`;
    const whenText = when(String(p.starts_at), Boolean(p.all_day), String(p.timezone));
    const body = `A subscriber to ${p.feed_name} says ${what}:\n\n${p.event_title} (${whenText})${p.details ? `\n\n"${p.details}"` : ""}\n\nCheck the event: ${link}`;
    const html = `<p>A subscriber to <strong>${esc(p.feed_name)}</strong> says ${esc(what)}:</p><p><strong>${esc(p.event_title)}</strong><br>${esc(whenText)}</p>${p.details ? `<blockquote style="border-left:4px solid #e3e3df;margin:0;padding-left:.75rem">${esc(p.details)}</blockquote>` : ""}<p><a href="${esc(link)}">Check the event</a></p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this because you run this feed and asked to hear about reports right away.", body, html) };
  }
  if (kind === "supporter_thanks") {
    const subject = "Thank you for supporting Calantern";
    const body = `Thank you. Your support keeps Calantern free for schools, teams and families.\n\nYour account now shows a supporter badge. You can choose to be listed on the supporters page: ${site}/account`;
    const html = `<p>Thank you. Your support keeps Calantern free for schools, teams and families.</p><p>Your account now shows a supporter badge. <a href="${esc(site)}/account">Choose whether to be listed</a> on the supporters page.</p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this once, because you linked your Buy Me a Coffee support to your account.", body, html) };
  }
  if (kind === "stale_nudge") {
    const link = `${site}/feeds/${p.feed_id}`;
    const subject = `${p.feed_name} hasn't had an update in ${p.days} days`;
    const body = `${p.feed_name} hasn't had an update in ${p.days} days, and it has nothing coming up. Families who subscribed will see an empty calendar.\n\nForward the next school or team email, or add an event: ${link}\n\nAfter 90 days without updates, the feed's page says it may be out of date.`;
    const html = `<p><strong>${esc(p.feed_name)}</strong> hasn't had an update in ${esc(p.days)} days, and it has nothing coming up. Families who subscribed will see an empty calendar.</p><p><a href="${esc(link)}">Add an event or forward an email</a></p><p style="color:#4f4f4b">After 90 days without updates, the feed's page says it may be out of date.</p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this once each time a feed you own goes quiet.", body, html) };
  }
  if (kind === "milestone") {
    const link = `${site}/feeds/${p.feed_id}/milestones/${p.milestone}`;
    const subject = `${p.milestone} calendars follow ${p.feed_name}`;
    const body = `Thank you. About ${p.milestone} calendars now follow ${p.feed_name}. That's a lot of families who don't have to copy dates by hand.\n\nA thank-you card to share: ${link}`;
    const html = `<p>Thank you. About <strong>${esc(p.milestone)}</strong> calendars now follow <strong>${esc(p.feed_name)}</strong>. That's a lot of families who don't have to copy dates by hand.</p><p><a href="${esc(link)}">See the thank-you card</a></p>`;
    return { subject, ...wrap(site, unsubscribe, "You get this when a feed you own reaches 10, 50 or 100 followers.", body, html) };
  }
  // weekly_digest
  const feeds = (p.feeds as Record<string, number | string>[] | undefined) ?? [];
  const trend = (a: number, b: number) => (a > b ? `up from ${b}` : a < b ? `down from ${b}` : "same as last week");
  const lines = feeds.map((f) =>
    `${f.name}\n  About ${f.subscribers} calendars follow it (${trend(Number(f.subscribers), Number(f.subscribers_last_week))}); ${f.taps} subscribe taps this week.\n  ${f.events_added} events added. ${f.needs_review} to review. ${f.reports} reports.\n  ${site}/feeds/${f.id}`);
  const review = feeds.reduce((n, f) => n + Number(f.needs_review), 0);
  const subject = review > 0 ? `Your Calantern week: ${review} to review` : "Your Calantern week";
  const body = `Here's your week.\n\n${lines.join("\n\n") || "You don't have any feeds yet."}\n\n"About" because a phone that switches networks can count twice, and Google and Outlook count once for all their users.`;
  const html = `<p>Here's your week.</p>${feeds.map((f) => `<p><a href="${esc(site)}/feeds/${esc(f.id)}"><strong>${esc(f.name)}</strong></a><br>About ${esc(f.subscribers)} calendars follow it (${esc(trend(Number(f.subscribers), Number(f.subscribers_last_week)))}); ${esc(f.taps)} subscribe taps this week.<br>${esc(f.events_added)} events added · <strong>${esc(f.needs_review)} to review</strong> · ${esc(f.reports)} reports</p>`).join("") || "<p>You don't have any feeds yet.</p>"}<p style="color:#4f4f4b">"About" because a phone that switches networks can count twice, and Google and Outlook count once for all their users.</p>`;
  return { subject, ...wrap(site, unsubscribe, "You get this every Monday because you run a Calantern feed.", body, html) };
}
