// Builds a subscribable RFC 5545 calendar from a feed and its events.
import { escapeText, serialize } from "./text.js";
import { formatDate, formatLocal, formatUtc, isValidTimeZone, nextDay, wallTime } from "./time.js";
import { vtimezone } from "./vtimezone.js";

export type EventStatus = "tentative" | "confirmed" | "cancelled";

export interface CalendarEvent {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO 8601 instant. For all-day events, any instant on the first day (in `timeZone`). */
  startsAt: string;
  /** ISO 8601 instant, or null. For all-day events, any instant on the last day (inclusive). */
  endsAt?: string | null;
  allDay: boolean;
  timeZone: string;
  /** RRULE value without the "RRULE:" prefix, e.g. "FREQ=WEEKLY;BYDAY=TU". */
  rrule?: string | null;
  status: EventStatus;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  /** Short source label shown in the description, e.g. the sender's domain. */
  source?: string | null;
}

export interface CalendarFeed {
  name: string;
  description?: string | null;
}

export interface BuildOptions {
  /** Used when an event's zone is invalid, and as X-WR-TIMEZONE when there are no events. */
  defaultTimeZone: string;
  /** Link for "Report a problem" in each event's description. */
  reportUrl?: (uid: string) => string;
  /** Product name and version for PRODID. */
  product?: string;
}

export interface BuildResult {
  ics: string;
  /** Things that were dropped or changed, e.g. an unsafe RRULE. Never contains event text. */
  warnings: string[];
}

// Only well-formed rules pass; anything else is dropped (and warned) rather than emitted.
const RRULE = /^FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/;

const STATUS: Record<EventStatus, string> = { tentative: "TENTATIVE", confirmed: "CONFIRMED", cancelled: "CANCELLED" };

function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error("Invalid date in calendar event");
  return t;
}

function eventLines(e: CalendarEvent, tz: string, opts: BuildOptions, warnings: string[]): string[] {
  const start = ms(e.startsAt);
  const end = e.endsAt ? ms(e.endsAt) : null;
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(e.uid)}`,
    // DTSTAMP follows the last change, not the request time, so identical data gives an identical
    // file and a stable ETag.
    `DTSTAMP:${formatUtc(ms(e.updatedAt))}`,
    `CREATED:${formatUtc(ms(e.createdAt))}`,
    `LAST-MODIFIED:${formatUtc(ms(e.updatedAt))}`,
    `SEQUENCE:${Math.max(0, Math.trunc(e.sequence))}`,
    `STATUS:${STATUS[e.status]}`,
    `SUMMARY:${escapeText(e.title)}`,
  ];

  if (e.allDay) {
    const first = wallTime(start, tz);
    const last = end !== null ? wallTime(end, tz) : first;
    lines.push(`DTSTART;VALUE=DATE:${formatDate(first)}`, `DTEND;VALUE=DATE:${formatDate(nextDay(last))}`);
  } else {
    lines.push(`DTSTART;TZID=${tz}:${formatLocal(wallTime(start, tz))}`);
    if (end !== null) lines.push(`DTEND;TZID=${tz}:${formatLocal(wallTime(end, tz))}`);
  }

  if (e.rrule) {
    if (RRULE.test(e.rrule)) lines.push(`RRULE:${e.rrule}`);
    else warnings.push(`dropped invalid RRULE on ${e.uid}`);
  }
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);

  const description = [
    e.description ?? "",
    e.source ? `Source: forwarded email from ${e.source}` : "",
    opts.reportUrl ? `Report a problem: ${opts.reportUrl(e.uid)}` : "",
  ]
    .filter((s) => s.trim() !== "")
    .join("\n\n");
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);

  lines.push("END:VEVENT");
  return lines;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

export function buildCalendar(feed: CalendarFeed, events: readonly CalendarEvent[], opts: BuildOptions): BuildResult {
  const warnings: string[] = [];
  const zoneOf = (e: CalendarEvent) => {
    if (isValidTimeZone(e.timeZone)) return e.timeZone;
    warnings.push(`unknown time zone on ${e.uid}; used ${opts.defaultTimeZone}`);
    return opts.defaultTimeZone;
  };
  const sorted = [...events].sort((a, b) => ms(a.startsAt) - ms(b.startsAt) || a.uid.localeCompare(b.uid));
  const zones = sorted.map(zoneOf);

  // One VTIMEZONE per zone used by a timed event, covering the years its events touch.
  const ranges = new Map<string, { from: number; to: number }>();
  sorted.forEach((e, i) => {
    if (e.allDay) return;
    const tz = zones[i] ?? opts.defaultTimeZone;
    const years = [ms(e.startsAt), e.endsAt ? ms(e.endsAt) : ms(e.startsAt)].map((t) => new Date(t).getUTCFullYear());
    const from = Math.min(...years) - 1;
    const to = Math.max(...years) + (e.rrule ? 5 : 1);
    const r = ranges.get(tz);
    ranges.set(tz, r ? { from: Math.min(r.from, from), to: Math.max(r.to, to) } : { from, to });
  });

  const calendarZone = mostCommon(zones) ?? opts.defaultTimeZone;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//Feedcal//${escapeText(opts.product ?? "Feedcal")}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(feed.name)}`,
    ...(feed.description ? [`X-WR-CALDESC:${escapeText(feed.description)}`] : []),
    `X-WR-TIMEZONE:${calendarZone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...[...ranges.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .flatMap(([tz, r]) => vtimezone(tz, r.from, r.to)),
    ...sorted.flatMap((e, i) => eventLines(e, zones[i] ?? opts.defaultTimeZone, opts, warnings)),
    "END:VCALENDAR",
  ];
  return { ics: serialize(lines), warnings };
}
