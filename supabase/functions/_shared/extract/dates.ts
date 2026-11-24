// D41: deterministic date rules. They check the model's date and time against the words it quoted
// and the email's sent date, so auto-publishing doesn't rest on the model's own confidence alone.
//   confirmed: the quote proves the date (a written date, or a relative day that resolves to
//              exactly one date) and, for timed events, any written time matches.
//   review:    the quote contradicts the event, or the day is genuinely ambiguous, or the event
//              is before the email was sent. These always wait for the owner.
// Anything else is "unconfirmed" and falls back to the feed's normal bar (45% unless changed, D85).

export interface DateGateInput {
  start: string;          // local wall time "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
  allDay: boolean;
  timezone: string;       // the event's zone
  quote: string;          // the model's evidence_quote
  referenceDate: string;  // ISO; when the original email was sent
}
export type DateReview = "ambiguous_date" | "date_mismatch" | "weekday_mismatch" | "time_mismatch" | "time_unlikely" | "before_email";
export interface DateGate {
  confirmed: boolean;
  review: DateReview[];
  /** When the day is ambiguous: every date the words could mean ("YYYY-MM-DD"), soonest first. */
  options?: string[];
}

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

/**
 * A time written in a text. `definite` is false when it has no AM/PM and nothing else settles the
 * half of the day; `minutes` is then the likely reading (D84) and `other` the unlikely one.
 */
export interface WrittenTime { minutes: number; definite: boolean; other?: number }

/** D84: with no AM/PM, 7 to 11 is morning and 12 to 6 is afternoon (school and team hours). */
function likely(h12: number, min: number): number {
  return ((h12 % 12) + (h12 >= 7 && h12 <= 11 ? 0 : 12)) * 60 + min;
}

/**
 * The times a text states: "3pm", "3:30 p.m.", "15:30", "noon", "midnight", "at 3:15".
 * - D83: in a range, an AM/PM on the end applies to the start too: "6:30-8 PM" is 6:30 PM to 8 PM
 *   (and "11-1 PM" is 11 AM to 1 PM, since the start can't be after the end).
 * - D84: a clock time with no AM/PM ("at 3:15") is read by the usual hours: 7 to 11 morning,
 *   12 to 6 afternoon. That reading is likely, not certain, so it is not `definite` unless the
 *   text also says morning, afternoon, evening or night. In a range with no AM/PM ("6:30-8"),
 *   the end is the first such time after the start.
 */
export function timesIn(text: string): WrittenTime[] {
  let t = text.toLowerCase();
  const out: WrittenTime[] = [];
  const at = (h12: number, min: number, pm: boolean) => ((h12 % 12) + (pm ? 12 : 0)) * 60 + min;
  const am = /\bmorning\b/.test(t);
  const pm = /\b(afternoon|evening|tonight|night)\b/.test(t);
  const hint = am === pm ? null : pm;
  const loose = (h12: number, min: number): WrittenTime => {
    if (hint !== null) return { minutes: at(h12, min, hint), definite: true };
    const minutes = likely(h12, min);
    return { minutes, definite: false, other: (minutes + 720) % 1440 };
  };
  const blank = (whole: string) => " ".repeat(whole.length);
  // Ranges first; what they use is blanked so the single-time patterns below don't read it again.
  t = t.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/g, (whole, h1, m1, h2, m2, ap) => {
    const isPm = ap === "p";
    const end = at(Number(h2), Number(m2 ?? 0), isPm);
    let start = at(Number(h1), Number(m1 ?? 0), isPm);
    if (start > end) start = at(Number(h1), Number(m1 ?? 0), !isPm);
    out.push({ minutes: start, definite: true }, { minutes: end, definite: true });
    return blank(whole);
  });
  t = t.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/g, (whole, h, m, ap) => {
    out.push({ minutes: at(Number(h), Number(m ?? 0), ap === "p"), definite: true });
    return blank(whole);
  });
  // A range with no AM/PM. At least one side must be written H:MM, so "Nov 20-21" is not a time.
  t = t.replace(/(?<![\d/:])(\d{1,2})(?::([0-5]\d))?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::([0-5]\d))?(?![\d/:])/g, (whole, h1, m1, h2, m2) => {
    const [a, b] = [Number(h1), Number(h2)];
    if ((m1 === undefined && m2 === undefined) || a < 1 || a > 12 || b < 1 || b > 12) return whole;
    const start = loose(a, Number(m1 ?? 0));
    let end = (b % 12) * 60 + Number(m2 ?? 0);
    if (end <= start.minutes) end += 720;
    if (end <= start.minutes) return whole;
    out.push(start, { minutes: end, definite: start.definite, ...(start.definite ? {} : { other: (end + 720) % 1440 }) });
    return blank(whole);
  });
  for (const x of t.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    const h = Number(x[1]);
    out.push(h === 0 || h > 12 ? { minutes: h * 60 + Number(x[2]), definite: true } : h === 12 ? (hint === false ? loose(12, Number(x[2])) : { minutes: 720 + Number(x[2]), definite: true }) : loose(h, Number(x[2])));
  }
  if (/\bnoon\b/.test(t)) out.push({ minutes: 12 * 60, definite: true });
  if (/\bmidnight\b/.test(t)) out.push({ minutes: 0, definite: true });
  return out;
}

/** Written times as minutes after midnight. A time with no AM/PM is given by its likely reading (D84). */
export function writtenTimes(text: string): number[] {
  return timesIn(text).map((x) => x.minutes);
}

/**
 * How a text's times bear on a clock time. "yes": the words state it outright. "maybe": the words
 * give it with no AM/PM and this is the likely half of the day. "unlikely": the same, but this is
 * the unusual half (3:15 read as 3:15 AM). "no": the words give other times. "silent": no time.
 */
export function timeStated(text: string, minutes: number): "yes" | "maybe" | "unlikely" | "no" | "silent" {
  const times = timesIn(text);
  if (times.length === 0) return "silent";
  if (times.some((x) => x.definite && x.minutes === minutes)) return "yes";
  if (times.some((x) => !x.definite && x.minutes === minutes)) return "maybe";
  return times.some((x) => !x.definite && x.other === minutes) ? "unlikely" : "no";
}

/**
 * D82: every calendar day a text states, as month and day. Written dates, plus the later days of
 * a range or list that follow one: "November 26 & 27", "Nov 26-28", "Nov 26 through 28", "11/26-28".
 */
export function statedDays(text: string): { m: number; d: number }[] {
  const t = text.toLowerCase();
  const out: { m: number; d: number }[] = writtenDates(t).map((v) => ({ m: v.m, d: v.d }));
  const more = String.raw`((?:\s*(?:&|and|to|through|thru|until|-|–|—)\s*\d{1,2}(?:st|nd|rd|th)?(?![\d/]|:\d))+)`;
  const later = (month: number, tail: string) => {
    for (const x of tail.matchAll(/(\d{1,2})(?:st|nd|rd|th)?/g)) out.push({ m: month, d: Number(x[1]) });
  };
  for (const x of t.matchAll(new RegExp(String.raw`\b(${MONTH_RE})\.?\s+\d{1,2}(?:st|nd|rd|th)?${more}`, "g"))) later(MONTHS[x[1]!]!, x[2]!);
  for (const x of t.matchAll(new RegExp(String.raw`(?<![\d/])(\d{1,2})\/\d{1,2}${more}`, "g"))) later(Number(x[1]), x[2]!);
  return out.filter((v) => v.m >= 1 && v.m <= 12 && v.d >= 1 && v.d <= 31);
}

/**
 * D82: does the text itself say the event runs to this later day? A written or ranged date for
 * that day counts. So does a range of weekdays ("Monday through Wednesday") that ends on its weekday.
 */
export function endDayStated(text: string, end: string): boolean {
  const [y, m, d] = end.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (statedDays(text).some((v) => v.m === m && v.d === d)) return true;
  const days = [...text.toLowerCase().matchAll(new RegExp(`\\b(${DAY_RE})\\b`, "g"))].map((x) => WEEKDAYS[x[1]!]!);
  return new Set(days).size >= 2 && days.includes(weekday({ y, m, d }));
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
  let ambiguous: number[] = [];
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
      else {
        review.add("ambiguous_date");
        ambiguous = [...new Set(matching.flat())].sort((a, b) => a - b);
      }
    }
  }

  // A written time must match a timed event's start. A time with no AM/PM proves nothing (D83):
  // read the usual way it needs the feed's bar like any unproven event; read the unusual way
  // (3:15 as 3:15 AM) it waits for the owner (D84).
  let timeOk = i.allDay;
  if (!i.allDay) {
    const [hh, mm] = i.start.slice(11, 16).split(":").map(Number) as [number, number];
    const said = timeStated(q, hh * 60 + mm);
    if (said === "yes") timeOk = true;
    else if (said === "no") review.add("time_mismatch");
    else if (said === "unlikely") review.add("time_unlikely");
  }

  const iso = (n: number) => { const v = fromDays(n); return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`; };
  return { confirmed: dateOk && timeOk && review.size === 0, review: [...review], ...(ambiguous.length > 1 ? { options: ambiguous.map(iso) } : {}) };
}
