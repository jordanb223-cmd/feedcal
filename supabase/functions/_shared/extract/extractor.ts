// Calls Claude with structured outputs. Small model first (the build plan's routing rule);
// the pipeline escalates to the large one. Only used when ANTHROPIC_API_KEY is set (D30).
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { OUTPUT_JSON_SCHEMA } from "./schema.ts";

export const SMALL_MODEL = "claude-haiku-5-5";
export const LARGE_MODEL = "claude-opus-5-5";
// $/token, from the claude-api reference (cached 2026-11-03). Estimates for logs and caps only.
export const PRICES: Record<string, { input: number; output: number }> = {
  [SMALL_MODEL]: { input: 0.1 / 1e6, output: 0.5 / 1e6 },
  [LARGE_MODEL]: { input: 4 / 1e6, output: 20 / 1e6 },
};

export interface ModelReply { json: unknown; refused: boolean; inputTokens: number; outputTokens: number; model: string }
export interface Extractor {
  /** `opts.schema` replaces the event-list schema for a different question (D70's date step). */
  run(model: string, system: string, user: string, opts?: { schema?: unknown; effort?: "low" | "medium" | "high" }): Promise<ModelReply>;
}

export function claudeExtractor(apiKey: string, client = new Anthropic({ apiKey })): Extractor {
  return {
    async run(model, system, user, opts) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: opts?.effort ?? (model === SMALL_MODEL ? "low" : "medium"), format: { type: "json_schema", schema: (opts?.schema ?? OUTPUT_JSON_SCHEMA) as typeof OUTPUT_JSON_SCHEMA } },
        // Haiku has no server-side refusal fallback; Opus 5.5 does.
        ...(model === LARGE_MODEL ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { json, refused: response.stop_reason === "refusal", inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: response.model };
    },
  };
}
