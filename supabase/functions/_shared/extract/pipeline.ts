// Phase 9: one message in, checked event candidates out.
//   small model → Zod → (retry once with the error) → escalate to the large model when unsure or
//   image-only → quote, time, date and timezone checks → candidates for the reconciler (Phase 10).
import { checkEvent, looksLikeInjection, type RejectReason, zonedToUtc } from "./checks.ts";
import { type Extractor, LARGE_MODEL, PRICES, SMALL_MODEL } from "./extractor.ts";
import { buildUserPrompt, type ExtractInput, SYSTEM_PROMPT } from "./prompt.ts";
import { ExtractionOutput, type ExtractedEvent } from "./schema.ts";

export interface Candidate extends ExtractedEvent {
  starts_at: string;
  ends_at: string | null;
  review: string[];
  from_transcription: boolean;
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
  for (const e of result.output.events) {
    const check = checkEvent(e, input);
    if (check.reject) {
      rejected.push({ event: e, reason: check.reject });
      continue;
    }
    const review = [...(check.review ?? []), ...(injection ? ["possible_injection"] : [])];
    candidates.push({ ...e, starts_at: zonedToUtc(e.start, e.timezone), ends_at: ends(e), review, from_transcription: check.fromTranscription });
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
