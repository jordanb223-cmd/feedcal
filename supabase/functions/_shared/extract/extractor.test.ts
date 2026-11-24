// D78: when the larger model is unavailable, the same question goes to the backup model.
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { BACKUP_MODEL, claudeExtractor, isUnavailable, LARGE_MODEL, type MessagesClient, SMALL_MODEL } from "./extractor.ts";

// An SDK error of a given class, without a network call.
const sdkError = (cls: { prototype: object }) => Object.create(cls.prototype) as Error;
const ok = (model: string) => ({ content: [{ type: "text", text: '{"events":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, model });

function client(fail: Record<string, Error>): MessagesClient & { asked: string[] } {
  const c = {
    asked: [] as string[],
    beta: { messages: { create(body: Record<string, unknown>) {
      const model = String(body.model);
      c.asked.push(model);
      return fail[model] ? Promise.reject(fail[model]) : Promise.resolve(ok(model));
    } } },
  };
  return c;
}

Deno.test("busy, overloaded or unreachable counts as unavailable; a bad request does not", () => {
  assertEquals([isUnavailable(sdkError(Anthropic.RateLimitError)), isUnavailable(sdkError(Anthropic.InternalServerError)), isUnavailable(sdkError(Anthropic.APIConnectionError))], [true, true, true]);
  assertEquals([isUnavailable(sdkError(Anthropic.BadRequestError)), isUnavailable(new Error("x"))], [false, false]);
});

Deno.test("the larger model being unavailable sends the question to the backup model", async () => {
  const c = client({ [LARGE_MODEL]: sdkError(Anthropic.RateLimitError) });
  const r = await claudeExtractor("k", c).run(LARGE_MODEL, "s", "u");
  assertEquals([c.asked, r.model, r.json], [[LARGE_MODEL, BACKUP_MODEL], BACKUP_MODEL, { events: [] }]);
});

Deno.test("a bad request is not retried elsewhere, and the small model has no backup", async () => {
  const bad = client({ [LARGE_MODEL]: sdkError(Anthropic.BadRequestError) });
  await assertRejects(() => claudeExtractor("k", bad).run(LARGE_MODEL, "s", "u"));
  assertEquals(bad.asked, [LARGE_MODEL]);
  const small = client({ [SMALL_MODEL]: sdkError(Anthropic.RateLimitError) });
  await assertRejects(() => claudeExtractor("k", small).run(SMALL_MODEL, "s", "u"));
  assertEquals(small.asked, [SMALL_MODEL], "the pipeline already escalates from the small model on its own");
});
