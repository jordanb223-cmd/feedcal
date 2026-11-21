// D41: deterministic date rules. They check the model's date and time against the words it quoted
// and the email's sent date, so auto-publishing doesn't rest on the model's own confidence alone.
//   confirmed: the quote proves the date (a written date, or a relative day that resolves to
//              exactly one date) and, for timed events, any written time matches.
//   review:    the quote contradicts the event, or the day is genuinely ambiguous, or the event
//              is before the email was sent. These always wait for the owner.
// Anything else is "unconfirmed" and falls back to the feed's normal bar (85% unless changed).

export interface DateGateInput {
  start: string;          // local wall time "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
  allDay: boolean;
  timezone: string;       // the event's zone
  quote: string;          // the model's evidence_quote
  referenceDate: string;  // ISO; when the original email was sent
}
export type DateReview = "ambiguous_date" | "date_mismatch" | "weekday_mismatch" | "time_mismatch" | "before_email";
export interface DateGate { confirmed: boolean; review: DateReview[] }

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");

interface Ymd { y: number; m: number; d: number }

/** The calendar date (and weekday) of an instant in a time zone. */
export function localDate(iso: string, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}
const toDays = (v: Ymd) => Math.floor(Date.UTC(v.y, v.m - 1, v.d) / 86_400_000);
const fromDays = (n: number): Ymd => { const t = new Date(n * 86_400_000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekday = (v: Ymd) => new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();

/** Written dates in the text: "Nov 20", "November 20th, 2026", "20 November", "11/20", "11/20/26", "2026-11-20". */
export function writtenDates(text: string): { m: number; d: number; y?: number }[] {
  const t = text.toLowerCase();
  const out: { m: number; d: number; y?: number }[] = [];
  const year = (s?: string) => (s ? (s.length === 2 ? 2000 + Number(s) : Number(s)) : undefined);
  for (const x of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"))) {
    out.push({ m: MONTHS[x[1]!]!, d: Number(x[2]), y: year(x[3]) });
  }
  for (const x of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, "g"))) {
    out.push({ m: MONTHS[x[2]!]!, d: Number(x[1]), y: year(x[3]) });
  }
  for (const x of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push({ y: Number(x[1]), m: Number(x[2]), d: Number(x[3]) });
  // US order (month/day). Not preceded by a digit or slash, so "2026/11/20" and fractions like 1/2/3 parts don't count twice.
  for (const x of t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g)) out.push({ m: Number(x[1]), d: Number(x[2]), y: year(x[3]) });
  return out.filter((v) => v.m >= 1 && v.m <= 12 && v.d >= 1 && v.d <= 31);
}

/** Written times as minutes after midnight: "3pm", "3:30 p.m.", "15:30", "noon". */
export function writtenTimes(text: string): number[] {
  const t = text.toLowerCase();
  const out: number[] = [];
  for (const x of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/g)) {
    let h = Number(x[1]) % 12;
    if (x[3] === "p") h += 12;
    out.push(h * 60 + Number(x[2] ?? 0));
  }
  for (const x of t.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s?m)/g)) out.push(Number(x[1]) * 60 + Number(x[2]));
  if (/\bnoon\b/.test(t)) out.push(12 * 60);
  if (/\bmidnight\b/.test(t)) out.push(0);
  return out;
}

export function dateGate(i: DateGateInput): DateGate {
  const review = new Set<DateReview>();
  const [y, m, d] = i.start.slice(0, 10).split("-").map(Number) as [number, number, number];
  const start: Ymd = { y, m, d };
  const ref = localDate(i.referenceDate, i.timezone);
  const refN = toDays(ref);
  const startN = toDays(start);
  const q = i.quote.toLowerCase();

  if (startN < refN) review.add("before_email");

  let dateOk = false;
  const dates = writtenDates(q);
  if (dates.length > 0) {
    // A written date: the event's date must be one of them (the first of a range, say).
    dateOk = dates.some((v) => v.m === m && v.d === d && (v.y === undefined || v.y === y));
    if (!dateOk) review.add("date_mismatch");
    // A weekday written next to it must agree ("Friday, Nov 20" for a Friday).
    const days = [...q.matchAll(new RegExp(`\\b(${DAY_RE})\\b`, "g"))].map((x) => WEEKDAYS[x[1]!]!);
    if (dateOk && days.length > 0 && !days.includes(weekday(start))) review.add("weekday_mismatch");
  } else {
    // Relative days, counted from the sent date in the event's zone.
    const options: number[][] = [];
    if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(q)) options.push([refN]);
    if (/\btomorrow\b/.test(q)) options.push([refN + 1]);
    for (const x of q.matchAll(new RegExp(`\\b(?:(this|next|coming|on|this coming)\\s+)?(${DAY_RE})\\b`, "g"))) {
      const before = q.slice(Math.max(0, (x.index ?? 0) - 12), x.index ?? 0);
      if (/\b(last|past)\s*$/.test(before)) continue; // "last Friday", "this past Friday": not a date we publish
      const delta = (WEEKDAYS[x[2]!]! - weekday(ref) + 7) % 7;
      if (x[1] === "next") options.push(delta === 0 ? [refN + 7] : [refN + delta, refN + delta + 7]); // "next Friday" on a Wednesday: 2 or 9 days
      else options.push(delta === 0 ? [refN, refN + 7] : [refN + delta]);                            // "this Friday" on a Friday: today or in 7
    }
    if (options.length > 0) {
      const matching = options.filter((o) => o.includes(startN));
      if (matching.length === 0) review.add("date_mismatch");
      else if (matching.some((o) => o.length === 1)) dateOk = true;
      else review.add("ambiguous_date");
    }
  }

  // A written time must match a timed event's start.
  let timeOk = i.allDay;
  if (!i.allDay) {
    const [hh, mm] = i.start.slice(11, 16).split(":").map(Number) as [number, number];
    const times = writtenTimes(q);
    if (times.length > 0) {
      timeOk = times.includes(hh * 60 + mm);
      if (!timeOk) review.add("time_mismatch");
    }
  }

  return { confirmed: dateOk && timeOk && review.size === 0, review: [...review] };
}
