// Calls Claude with structured outputs. Small model first (the build plan's routing rule);
// the pipeline escalates to the large one. Only used when ANTHROPIC_API_KEY is set (D30).
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { OUTPUT_JSON_SCHEMA } from "./schema.ts";

export const SMALL_MODEL = "claude-haiku-5-5";
// D75: the second opinion and the unclear-date question run on Sonnet 5.5, not Opus 5.5: half the
// price, and both are short, well-bounded questions.
export const LARGE_MODEL = "claude-sonnet-5-5";
// $/token, from the claude-api reference (cached 2026-11-03). Estimates for logs and caps only.
// D78: if the larger model can't answer (rate limit, overload, outage) after the SDK's own retries,
// the same question goes to Opus 5.5 rather than leaving the email unread.
export const BACKUP_MODEL = "claude-opus-5-5";
export const PRICES: Record<string, { input: number; output: number }> = {
  [SMALL_MODEL]: { input: 0.1 / 1e6, output: 0.5 / 1e6 },
  [LARGE_MODEL]: { input: 2 / 1e6, output: 10 / 1e6 },
  [BACKUP_MODEL]: { input: 4 / 1e6, output: 20 / 1e6 },
};

export interface ModelReply { json: unknown; refused: boolean; inputTokens: number; outputTokens: number; model: string }
export interface Extractor {
  /** `opts.schema` replaces the event-list schema for a different question (D70's date step). */
  run(model: string, system: string, user: string, opts?: { schema?: unknown; effort?: "low" | "medium" | "high" }): Promise<ModelReply>;
}

/** Failures worth trying another model for: the service is busy or unreachable, not a bad request. */
export function isUnavailable(e: unknown): boolean {
  return e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
}

// Just the call this module makes; lets a test stand in for the client.
export interface MessagesClient { beta: { messages: { create(body: Record<string, unknown>): Promise<unknown> } } }

export function claudeExtractor(apiKey: string, client: MessagesClient = new Anthropic({ apiKey }) as unknown as MessagesClient): Extractor {
  const call = async (model: string, system: string, user: string, opts?: { schema?: unknown; effort?: "low" | "medium" | "high" }): Promise<ModelReply> => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: opts?.effort ?? (model === SMALL_MODEL ? "low" : "medium"), format: { type: "json_schema", schema: opts?.schema ?? OUTPUT_JSON_SCHEMA } },
      // Haiku has no server-side refusal fallback; Sonnet 5.5 and Opus 5.5 do (the "default" form).
      ...(model !== SMALL_MODEL ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      system,
      messages: [{ role: "user", content: user }],
    }) as { content: { type: string; text?: string }[]; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number }; model: string };
    const text = response.content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { json, refused: response.stop_reason === "refusal", inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: response.model };
  };
  return {
    async run(model, system, user, opts) {
      try {
        return await call(model, system, user, opts);
      } catch (e) {
        if (model !== LARGE_MODEL || !isUnavailable(e)) throw e;
        return await call(BACKUP_MODEL, system, user, opts);
      }
    },
  };
}
