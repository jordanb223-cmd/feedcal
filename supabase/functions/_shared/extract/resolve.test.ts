// D70: unclear days are reasoned out by the large model, within what the date rules allow;
// a time the words don't state turns the event into an all-day one.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Extractor, LARGE_MODEL, type ModelReply } from "./extractor.ts";
import { alreadyPast, extractEvents, moveToDate, withoutUnstatedTime } from "./pipeline.ts";
import type { ExtractInput } from "./prompt.ts";
import { DATE_DECISION_SCHEMA, RESOLVE_SYSTEM } from "./resolve.ts";
import type { ExtractedEvent } from "./schema.ts";

// Friday 20 Nov 2026, 8am Pacific.
const input: ExtractInput = {
  referenceDate: "2026-11-20T16:00:00Z", timezone: "America/Los_Angeles", feedName: "Room F", feedCategory: "school",
  subject: "TGIF", sender: "teacher@school.example", pages: [],
  body: "Happy Friday! This Friday is Dinosgiving! Bring your dish to share this afternoon. Next week we are off for Thanksgiving.",
};
const event = (over: Partial<ExtractedEvent> = {}): ExtractedEvent => ({
  title: "Dinosgiving potluck", start: "2026-11-20", end: null, all_day: true, timezone: "America/Los_Angeles", location: null, description: null,
  recurrence: null, status: "new", confidence: 0.55, evidence_quote: "This Friday is Dinosgiving!", source_ref: { kind: "body", attachment_id: null, page_index: null }, ...over,
});

/** Replies in order; records every call. */
function scripted(replies: unknown[]): Extractor & { seen: { model: string; system: string; user: string; opts?: { schema?: unknown; effort?: string } }[] } {
  const queue = [...replies];
  const ex = {
    seen: [] as { model: string; system: string; user: string; opts?: { schema?: unknown; effort?: string } }[],
    run(model: string, system: string, user: string, opts?: { schema?: unknown; effort?: "low" | "medium" | "high" }): Promise<ModelReply> {
      ex.seen.push({ model, system, user, opts });
      return Promise.resolve({ json: queue.shift() ?? { events: [] }, refused: false, inputTokens: 1000, outputTokens: 100, model });
    },
  };
  return ex;
}
const extraction = (e: ExtractedEvent) => ({ events: [e] });
// These emails were sent on 20 Nov 2026; judge them as of that morning, whatever today is.
const AS_OF = { now: Date.parse("2026-11-20T16:00:00Z") };

Deno.test("an unclear day the model settles with certainty is no longer held, and counts as proven", async () => {
  const ex = scripted([extraction(event({ confidence: 0.75 })), { date: "2026-11-20", certain: true, reason: "The email says to bring the dish this afternoon." }]);
  const r = await extractEvents(input, ex, AS_OF);
  assertEquals(r.candidates.length, 1);
  assertEquals(r.candidates[0]?.review, []);
  assertEquals(r.candidates[0]?.date_confirmed, true);
  assertEquals(r.candidates[0]?.start, "2026-11-20");
  const question = ex.seen.at(-1)!;
  assertEquals([question.model, question.system, question.opts?.schema, question.opts?.effort], [LARGE_MODEL, RESOLVE_SYSTEM, DATE_DECISION_SCHEMA, "medium"]);
  assert(question.user.includes("Candidate dates: 2026-11-20 (Friday), 2026-11-27 (Friday)"));
  assert(question.user.includes("sent on Friday, 2026-11-20"));
  assertEquals(r.calls.length, 2, "the question is counted as a call, so its cost is tracked");
});

Deno.test("when the model picks the later day, the event moves there", async () => {
  const ex = scripted([extraction(event({ confidence: 0.75 })), { date: "2026-11-27", certain: true, reason: "x" }]);
  const r = await extractEvents(input, ex, AS_OF);
  assertEquals([r.candidates[0]?.start, r.candidates[0]?.starts_at.slice(0, 10), r.candidates[0]?.review.length], ["2026-11-27", "2026-11-27", 0]);
});

Deno.test("not certain, no date, a date outside the candidates, or a broken answer: the event still waits", async () => {
  for (const answer of [
    { date: "2026-11-20", certain: false, reason: "likely today" },
    { date: null, certain: false, reason: "the email does not say" },
    { date: "2026-11-21", certain: true, reason: "made up" },
    { nonsense: true },
  ]) {
    const r = await extractEvents(input, scripted([extraction(event({ confidence: 0.75 })), answer]), AS_OF);
    assertEquals(r.candidates[0]?.review, ["ambiguous_date"], JSON.stringify(answer));
    assertEquals(r.candidates[0]?.date_confirmed, false);
    assertEquals(r.candidates[0]?.start, "2026-11-20");
  }
});

Deno.test("a clear date asks no extra question", async () => {
  const clear: ExtractInput = { ...input, body: "Dinosgiving is on Friday, November 20." };
  const ex = scripted([extraction(event({ confidence: 0.9, evidence_quote: "Dinosgiving is on Friday, November 20." }))]);
  const r = await extractEvents(clear, ex, AS_OF);
  assertEquals([ex.seen.length, r.candidates[0]?.date_confirmed], [1, true]);
});

Deno.test("at most three questions per email", async () => {
  const many = { events: [1, 2, 3, 4, 5].map((n) => event({ title: `Event ${n}`, confidence: 0.75 })) };
  const ex = scripted([many]);
  await extractEvents(input, ex, AS_OF);
  assertEquals(ex.seen.length, 1 + 3);
});

Deno.test("a time the words don't state makes the event all-day instead of dropping it", async () => {
  const timed = event({ all_day: false, start: "2026-11-20T15:00", end: "2026-11-20T16:00", confidence: 0.9, evidence_quote: "Dinosgiving is on Friday, November 20." });
  assertEquals(withoutUnstatedTime(timed), { ...timed, all_day: true, start: "2026-11-20", end: "2026-11-20" });
  const stated = event({ all_day: false, start: "2026-11-20T15:00", evidence_quote: "Friday, November 20 at 3pm" });
  assertEquals(withoutUnstatedTime(stated), stated);
  const clear: ExtractInput = { ...input, body: "Dinosgiving is on Friday, November 20." };
  const r = await extractEvents(clear, scripted([extraction(timed)]), AS_OF);
  assertEquals([r.rejected.length, r.candidates[0]?.all_day, r.candidates[0]?.start], [0, true, "2026-11-20"]);
});

Deno.test("D72: an event read from a photo or scan is not held for that, but gets no proven-date shortcut", async () => {
  const flyer: ExtractInput = { ...input, body: "", pages: [{ attachment_id: "11111111-1111-4111-8111-111111111111", page_index: 0, source: "transcription", filename: "flyer.jpg", text: "Dinosgiving is on Friday, November 20." }] };
  const fromPage = event({ confidence: 0.9, evidence_quote: "Dinosgiving is on Friday, November 20.", source_ref: { kind: "page", attachment_id: "11111111-1111-4111-8111-111111111111", page_index: 0 } });
  const r = await extractEvents(flyer, scripted([extraction(fromPage)]), AS_OF);
  assertEquals([r.candidates[0]?.review, r.candidates[0]?.from_transcription, r.candidates[0]?.date_confirmed], [[], true, false]);
});

Deno.test("D75: a page the two readers disagreed on sends its events to review", async () => {
  const flyer: ExtractInput = { ...input, body: "", pages: [{ attachment_id: "11111111-1111-4111-8111-111111111111", page_index: 0, source: "transcription_unsure", filename: "flyer.jpg", text: "Dinosgiving is on Friday, November 20." }] };
  const fromPage = event({ confidence: 0.95, evidence_quote: "Dinosgiving is on Friday, November 20.", source_ref: { kind: "page", attachment_id: "11111111-1111-4111-8111-111111111111", page_index: 0 } });
  const r = await extractEvents(flyer, scripted([extraction(fromPage)]), AS_OF);
  assertEquals([r.candidates[0]?.review, r.candidates[0]?.from_transcription], [["from_transcription"], true]);
});

Deno.test("D77: an event dated before today is dropped, whenever the email is read; a repeating one is kept", async () => {
  const clear: ExtractInput = { ...input, body: "Dinosgiving is on Friday, November 20." };
  const e = event({ confidence: 0.9, evidence_quote: "Dinosgiving is on Friday, November 20." });
  const late = await extractEvents(clear, scripted([extraction(e)]), { now: Date.parse("2026-11-24T02:00:00Z") }); // 23 Nov, 6pm Pacific
  assertEquals([late.candidates.length, late.rejected.map((r) => r.reason)], [0, ["already_past"]]);
  const sameDay = await extractEvents(clear, scripted([extraction(e)]), { now: Date.parse("2026-11-21T05:00:00Z") }); // still 20 Nov in Pacific
  assertEquals(sameDay.candidates.length, 1);
  assertEquals(alreadyPast({ ...e, recurrence: "FREQ=WEEKLY" }, Date.parse("2027-01-01T00:00:00Z")), false);
  assertEquals(alreadyPast({ ...e, start: "2026-11-20", end: "2026-11-27" }, Date.parse("2026-11-24T02:00:00Z")), false, "a range that is still running is kept");
});

Deno.test("moving an event keeps its time of day and its length", () => {
  const e = event({ all_day: false, start: "2026-11-20T15:00", end: "2026-11-21T09:30" });
  assertEquals([moveToDate(e, "2026-11-27").start, moveToDate(e, "2026-11-27").end], ["2026-11-27T15:00", "2026-11-28T09:30"]);
});
