// Deterministic checks on what the model returned. Each failure has a reason the review screen
// can show. Nothing here calls the model.
import type { ExtractedEvent } from "./schema.ts";
import type { ExtractInput } from "./prompt.ts";
import { dateGate } from "./dates.ts";

/** Whitespace, curly quotes, dashes and case normalised, so a faithful quote always matches. */
export function normalise(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "") // invisible characters, removed before the model sees the text too (D59)
    .normalize("NFKC")
    .replace(/‹/g, "<") // the prompt guard turns a fake tag's "<" into "‹" (D59); quotes may include it
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface SourceText { text: string; fromTranscription: boolean }

export function sourceFor(e: ExtractedEvent, input: ExtractInput): SourceText | null {
  if (e.source_ref.kind === "body") return { text: input.body, fromTranscription: false };
  const page = input.pages.find((p) => p.attachment_id === e.source_ref.attachment_id && p.page_index === e.source_ref.page_index);
  return page ? { text: page.text, fromTranscription: page.source === "transcription" } : null;
}

export function quoteFound(quote: string, source: string): boolean {
  const q = normalise(quote);
  return q.length >= 3 && normalise(source).includes(q);
}

const TIME_IN_TEXT = /\b\d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)|\b\d{1,2}:\d{2}\b|\b\d{1,2}h\d{0,2}\b|\bnoon\b|\bmidnight\b/i;
export const hasTime = (quote: string) => TIME_IN_TEXT.test(quote);

/** Phrases that try to steer an AI. Their presence means nothing from this email auto-publishes. */
const INJECTION = /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions|rules|prompt|above|previous)\b|\b(system prompt|you are (now )?(an?|the) (ai|assistant|model))\b|\bas an ai\b|\b(add|create|insert) (this|the following|an?) events?\b[^.\n]{0,40}\b(calendar|feed)\b/i;
export function looksLikeInjection(input: ExtractInput): boolean {
  return INJECTION.test(input.body) || input.pages.some((p) => INJECTION.test(p.text)) || INJECTION.test(input.subject ?? "");
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local wall time in `tz` → UTC ISO. Two passes settle DST edges. */
export function zonedToUtc(local: string, tz: string): string {
  const [d, t = "00:00"] = local.split("T");
  const [y, mo, da] = d!.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const wall = Date.UTC(y!, mo! - 1, da!, h!, mi!);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - ms;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess).toISOString();
}

// Children's safety (Phase 14): personal details in an event's title or description send it to
// review instead of publishing. Locations are exempt (venues have street addresses).
const PHONE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i;
const HOME_ADDRESS = /\b\d{1,5}\s+[A-Za-z0-9.'-]+(\s+[A-Za-z0-9.'-]+){0,3}\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|boulevard|pl|place|cir|circle|ter|terrace)\b\.?/i;
export function personalDetails(e: { title: string; description: string | null }): string[] {
  const text = `${e.title}\n${e.description ?? ""}`;
  return [PHONE.test(text) ? "phone" : "", EMAIL.test(text) ? "email" : "", HOME_ADDRESS.test(text) ? "street_address" : ""].filter(Boolean);
}

export type RejectReason = "quote_not_found" | "unknown_source" | "bad_timezone" | "time_not_in_quote" | "end_before_start" | "date_out_of_range" | "bad_recurrence";

export const LOW_CONFIDENCE = 0.5;

/** Hard failures reject the event; soft ones keep it but send it to review. */
export function checkEvent(e: ExtractedEvent, input: ExtractInput): { reject?: RejectReason; review?: string[]; fromTranscription: boolean; dateConfirmed?: boolean; dateOptions?: string[] } {
  const source = sourceFor(e, input);
  if (!source) return { reject: "unknown_source", fromTranscription: false };
  if (!quoteFound(e.evidence_quote, source.text)) return { reject: "quote_not_found", fromTranscription: source.fromTranscription };
  if (!isTimeZone(e.timezone)) return { reject: "bad_timezone", fromTranscription: source.fromTranscription };
  if (e.all_day !== !e.start.includes("T")) return { reject: "end_before_start", fromTranscription: source.fromTranscription };
  if (!e.all_day && !hasTime(e.evidence_quote)) return { reject: "time_not_in_quote", fromTranscription: source.fromTranscription };
  if (e.end && e.end < e.start) return { reject: "end_before_start", fromTranscription: source.fromTranscription };
  if (e.recurrence && !/^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY))(;(BYDAY|BYMONTHDAY|INTERVAL|COUNT|UNTIL)=[A-Z0-9,+-]+)*$/.test(e.recurrence)) {
    return { reject: "bad_recurrence", fromTranscription: source.fromTranscription };
  }
  const start = Date.parse(zonedToUtc(e.start, e.timezone));
  const ref = Date.parse(input.referenceDate);
  const day = 86_400_000;
  if (start < ref - 31 * day || start > ref + 550 * day) return { reject: "date_out_of_range", fromTranscription: source.fromTranscription };
  const review: string[] = [];
  // Below this, always ask the owner. Between it and the feed's own setting (70% unless the owner
  // lowers it), the reconciler decides. Lowered from 0.7 so an owner's 50-60% setting can work (D40).
  if (e.confidence < LOW_CONFIDENCE) review.push("low_confidence");
  // D72: an event read from a photo or scan no longer waits just for that (owner's decision). It
  // publishes under the feed's bar like any other. What it does not get is the "proven date"
  // shortcut below: the quote is checked against the transcription, not the picture, so a misread
  // digit would "prove" itself.
  if (personalDetails(e).length) review.push("personal_details");
  // D41: the date rules. A contradiction or ambiguity always waits for the owner; a date the
  // quote proves lets a trusted sender's event publish at 50% instead of the feed's bar.
  const gate = dateGate({ start: e.start, allDay: e.all_day, timezone: e.timezone, quote: e.evidence_quote, referenceDate: input.referenceDate });
  review.push(...gate.review);
  // Changes and cancellations aren't flagged here: from a trusted sender at high confidence they
  // apply automatically (D31), so subscribers see a moved practice without the owner stepping in.
  return { review, fromTranscription: source.fromTranscription, dateConfirmed: gate.confirmed && !source.fromTranscription, dateOptions: gate.options };
}
