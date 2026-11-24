// Phase 9: one message in, checked event candidates out.
//   small model → Zod → (retry once with the error) → escalate to the large model when unsure or
//   image-only → quote, time, date and timezone checks → candidates for the reconciler (Phase 10).
import { checkEvent, hasTime, looksLikeInjection, type RejectReason, zonedToUtc } from "./checks.ts";
import { type DateReview, localDate, writtenTimes } from "./dates.ts";
import { resolveDate } from "./resolve.ts";
import { type Extractor, LARGE_MODEL, PRICES, SMALL_MODEL } from "./extractor.ts";
import { buildUserPrompt, type ExtractInput, SYSTEM_PROMPT } from "./prompt.ts";
import { ExtractionOutput, type ExtractedEvent } from "./schema.ts";

export interface Candidate extends ExtractedEvent {
  starts_at: string;
  ends_at: string | null;
  review: string[];
  from_transcription: boolean;
  date_confirmed: boolean; // D41: the quote proves the date (and time)
}
export interface Rejected { event: ExtractedEvent; reason: RejectReason }
export interface ExtractionResult {
  state: "extracted" | "needs_review" | "refused";
  reason: string | null;
  candidates: Candidate[];
  rejected: Rejected[];
  calls: { model: string; inputTokens: number; outputTokens: number; costUsd: number; valid: boolean }[];
  model: string | null;
}

const ESCALATE_BELOW = 0.7;
// D70: at most this many "which day did they mean?" questions per email (each is a large-model call).
const MAX_DATE_QUESTIONS = 3;
const DATE_REASONS: readonly string[] = ["ambiguous_date", "date_mismatch", "weekday_mismatch", "time_mismatch", "before_email"] satisfies DateReview[];

const ymd = (v: { y: number; m: number; d: number }) => `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const shiftDate = (date: string, days: number) => new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);

/** The same event on another day: the time of day and the length stay as they were. */
export function moveToDate(e: ExtractedEvent, date: string): ExtractedEvent {
  const delta = dayNumber(date) - dayNumber(e.start.slice(0, 10));
  return { ...e, start: date + e.start.slice(10), end: e.end ? shiftDate(e.end.slice(0, 10), delta) + e.end.slice(10) : null };
}

/** D70: a time the quoted words don't state is never kept; the event becomes all-day. */
export function withoutUnstatedTime(e: ExtractedEvent): ExtractedEvent {
  if (e.all_day || hasTime(e.evidence_quote)) return e;
  return { ...e, all_day: true, start: e.start.slice(0, 10), end: e.end ? e.end.slice(0, 10) : null };
}

function ends(e: ExtractedEvent): string | null {
  if (!e.end) return null;
  if (e.all_day) {
    // Inclusive last day → stored as an instant on that day (D22 convention).
    return zonedToUtc(e.end, e.timezone);
  }
  return zonedToUtc(e.end.includes("T") ? e.end : `${e.end}T23:59`, e.timezone);
}

export async function extractEvents(input: ExtractInput, extractor: Extractor): Promise<ExtractionResult> {
  const calls: ExtractionResult["calls"] = [];
  const user = buildUserPrompt(input);

  async function attempt(model: string): Promise<{ output: ExtractionOutput | null; refused: boolean; error: string | null }> {
    let prompt = user;
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      const reply = await extractor.run(model, SYSTEM_PROMPT, prompt);
      const price = PRICES[model] ?? PRICES[LARGE_MODEL]!;
      const parsed = ExtractionOutput.safeParse(reply.json);
      calls.push({ model: reply.model, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd: reply.inputTokens * price.input + reply.outputTokens * price.output, valid: parsed.success });
      if (reply.refused) return { output: null, refused: true, error: "refused" };
      if (parsed.success) return { output: parsed.data, refused: false, error: null };
      // Retry once, telling the model what was wrong.
      prompt = `${user}\n\nYour previous answer did not match the required format: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Answer again.`;
    }
    return { output: null, refused: false, error: "invalid_output" };
  }

  const imageOnly = !input.body.trim() && input.pages.length > 0 && input.pages.every((p) => p.source === "transcription");
  let model = imageOnly ? LARGE_MODEL : SMALL_MODEL;
  let result = await attempt(model);
  const unsure = result.output?.events.some((e) => e.confidence < ESCALATE_BELOW) ?? false;
  if (model === SMALL_MODEL && (unsure || result.error === "invalid_output")) {
    model = LARGE_MODEL;
    const second = await attempt(model);
    if (second.output || second.refused) result = second;
  }
  if (result.refused) return { state: "refused", reason: "model_refused", candidates: [], rejected: [], calls, model };
  if (!result.output) return { state: "needs_review", reason: "invalid_output", candidates: [], rejected: [], calls, model };

  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];
  const injection = looksLikeInjection(input);
  let dateQuestions = 0;
  for (const found of result.output.events) {
    let e = withoutUnstatedTime(found);
    const check = checkEvent(e, input);
    if (check.reject) {
      rejected.push({ event: e, reason: check.reject });
      continue;
    }
    let review = [...(check.review ?? []), ...(injection ? ["possible_injection"] : [])];
    let dateConfirmed = check.dateConfirmed ?? false;
    // D70: the words fit more than one day. Ask the large model to reason it out from the whole
    // email. It can only pick one of the days the rules allow; if it isn't certain, the event waits.
    if (!injection && review.includes("ambiguous_date") && check.dateOptions && dateQuestions < MAX_DATE_QUESTIONS) {
      dateQuestions++;
      const answer = await resolveDate(input, e, check.dateOptions, ymd(localDate(input.referenceDate, e.timezone)), extractor);
      const price = PRICES[LARGE_MODEL]!;
      calls.push({ model: answer.reply.model, inputTokens: answer.reply.inputTokens, outputTokens: answer.reply.outputTokens, costUsd: answer.reply.inputTokens * price.input + answer.reply.outputTokens * price.output, valid: answer.valid });
      if (answer.date) {
        e = moveToDate(e, answer.date);
        review = review.filter((r) => r !== "ambiguous_date");
        const timeProven = e.all_day || writtenTimes(e.evidence_quote).includes(Number(e.start.slice(11, 13)) * 60 + Number(e.start.slice(14, 16)));
        dateConfirmed = timeProven && !check.fromTranscription && !review.some((r) => DATE_REASONS.includes(r));
      }
    }
    candidates.push({ ...e, starts_at: zonedToUtc(e.start, e.timezone), ends_at: ends(e), review, from_transcription: check.fromTranscription, date_confirmed: dateConfirmed });
  }
  return {
    state: injection ? "needs_review" : "extracted",
    reason: injection ? "possible_injection" : null,
    candidates,
    rejected,
    calls,
    model,
  };
}
