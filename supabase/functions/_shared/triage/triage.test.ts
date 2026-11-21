// Phase 8 "passes when": a 40-page newsletter sends at most 5 pages to the AI; a flyer photo's
// transcription holds its events (here with a fake transcriber: no paid API in tests); and a
// learned "this one" rule sends the next email straight to the right file.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { scorePage } from "./score.ts";
import { RefusedError, type Transcriber, type TranscribeInput } from "./transcriber.ts";
import { type AttachmentIn, estimateVisionTokens, triageMessage, type TriageDeps } from "./triage.ts";

async function pdf(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, i) => line && page.drawText(line, { x: 40, y: 740 - i * 16, size: 11, font }));
  }
  return doc.save();
}

const PROSE = [
  "Thank you to every family who helped with the reading program this term.",
  "Our students have grown so much, and the library is busier than ever before.",
  "Please remember to label jackets and lunch boxes with your child's name.",
  "The garden club planted bulbs along the front walk; ask your child about it.",
];
const SCHEDULE_A = ["Upcoming events", "Fri Nov 21 | Picture day | 8:30 AM", "Tue Nov 25 | Early dismissal | 12:30 PM", "Nov 26-28 | Thanksgiving break, no school", "Thu Dec 11 | Winter concert | 6:30 PM"];
const SCHEDULE_B = ["December", "Mon Dec 1 | Book fair opens | 8:00 AM", "Fri Dec 5 | Field trip to the science museum | 8:45 AM", "Wed Dec 10 | Dress rehearsal | 2:00 PM", "Fri Dec 19 | Last day before winter break"];

function att(id: string, over: Partial<AttachmentIn> = {}): AttachmentIn {
  return { id, filename: `${id}.pdf`, mime: "application/pdf", bytes: 100_000, storage_path: `f/m/${id}`, status: "pending", chosen: false, width: null, height: null, seen_before: false, owner_never: false, ...over };
}

function deps(files: Record<string, Uint8Array>, opts: { transcriber?: Transcriber; textQuota?: number; visionQuota?: number } = {}) {
  const asked: { kind: string; wanted: number }[] = [];
  let text = opts.textQuota ?? 300;
  let vision = opts.visionQuota ?? 20;
  const d: TriageDeps = {
    readFile: async (path) => {
      const f = files[path];
      if (!f) throw new Error("missing");
      return f;
    },
    ...(opts.transcriber ? { transcriber: opts.transcriber } : {}),
    quota: async (kind, wanted) => {
      asked.push({ kind, wanted });
      const pool = kind === "text_pages" ? text : vision;
      const grant = Math.min(pool, wanted);
      if (kind === "text_pages") text -= grant; else vision -= grant;
      return grant;
    },
  };
  return { d, asked };
}

function fakeTranscriber(text: string | ((i: TranscribeInput) => string)) {
  const calls: TranscribeInput[] = [];
  const t: Transcriber = {
    transcribe: async (input) => {
      calls.push(input);
      return { text: typeof text === "string" ? text : text(input), inputTokens: 1500, outputTokens: 120, model: "fake" };
    },
  };
  return { t, calls };
}

Deno.test("scoring: a schedule page beats a page of prose", () => {
  assert(scorePage(0, SCHEDULE_A.join("\n")).score >= 3);
  assert(scorePage(1, PROSE.join("\n")).score < 3);
});

Deno.test("a 40-page newsletter sends at most 5 pages, and they are the schedule pages", async () => {
  const pages = Array.from({ length: 40 }, (_, i) => (i === 16 ? SCHEDULE_A : i === 17 ? SCHEDULE_B : PROSE));
  const { d, asked } = deps({ "f/m/newsletter": await pdf(pages) });
  const [r] = await triageMessage([att("newsletter")], null, d);
  assertEquals(r?.status, "text_layer");
  assertEquals(r?.pages_total, 40);
  assert((r?.pages.length ?? 99) <= 5, `kept ${r?.pages.length}`);
  assertEquals(r?.triage.keptPages, [16, 17]);
  assert(r?.pages[0]?.text.includes("Picture day"));
  assertEquals(r?.triage.scores?.length, 40);
  assert(asked.every((a) => a.wanted <= 5));
});

Deno.test("over 40 pages is skipped, unless the sender's schedules come as big attachments", async () => {
  const pages = Array.from({ length: 41 }, (_, i) => (i === 3 ? SCHEDULE_A : PROSE));
  const files = { "f/m/big": await pdf(pages) };
  const [skipped] = await triageMessage([att("big")], null, deps(files).d);
  assertEquals([skipped?.status, skipped?.triage.reason], ["skipped", "too_many_pages"]);
  const [read] = await triageMessage([att("big")], { version: 1, allowLarge: true }, deps(files).d);
  assertEquals([read?.status, read?.triage.keptPages], ["text_layer", [3]]);
});

Deno.test("the 5-page budget is shared across a message's attachments, best pages first", async () => {
  const many = Array.from({ length: 4 }, () => SCHEDULE_A);
  const files = { "f/m/a": await pdf(many), "f/m/b": await pdf([...many, PROSE]) };
  const results = await triageMessage([att("a"), att("b")], null, deps(files).d);
  const kept = results.reduce((n, r) => n + r.pages.length, 0);
  assertEquals(kept, 5);
});

Deno.test("a flyer photo is transcribed (vision last), and its events are in the transcription", async () => {
  const flyer = "FALL FESTIVAL\nSaturday, October 18 | 11 AM - 3 PM\nOak Street School field\nPie contest at 1 PM";
  const { t, calls } = fakeTranscriber(flyer);
  const files = { "f/m/flyer": new Uint8Array(300_000) };
  const [r] = await triageMessage([att("flyer", { filename: "fall-festival-flyer.jpg", mime: "image/jpeg", bytes: 300_000, width: 1200, height: 1600 })], null, deps(files, { transcriber: t }).d);
  assertEquals(r?.status, "transcribed");
  assertEquals(r?.pages, [{ index: 0, text: flyer, source: "transcription" }]);
  assert(r?.pages[0]?.text.includes("Saturday, October 18 | 11 AM - 3 PM"), "the event's quote is findable in the stored text");
  assertEquals(calls[0]?.kind, "image");
  assertEquals(r?.triage.visionTokens, { input: 1500, output: 120 });
  assertEquals(r?.triage.costUsd, 0.0084); // 1500 × $4/M + 120 × $20/M
});

Deno.test("without a vision key, images wait (pending) instead of failing", async () => {
  const [r] = await triageMessage([att("flyer", { mime: "image/png", filename: "flyer.png" })], null, deps({ "f/m/flyer": new Uint8Array(10) }).d);
  assertEquals([r?.status, r?.triage.reason], ["pending", "needs_vision_not_configured"]);
});

Deno.test("a scanned PDF sends only its first 2 pages to vision, or the page the owner chose", async () => {
  const blank = Array.from({ length: 6 }, () => [""]);
  const files = { "f/m/scan": await pdf(blank) };
  const first = fakeTranscriber("Practice Tuesdays 5 PM");
  const [r] = await triageMessage([att("scan")], null, deps(files, { transcriber: first.t }).d);
  assertEquals([r?.status, r?.pages_total, first.calls.length, first.calls[0]?.kind], ["transcribed", 6, 2, "pdf_page"]);
  const second = fakeTranscriber("Game day schedule");
  const [p] = await triageMessage([att("scan")], { version: 1, prefer: [{ pattern: "^scan\\.pdf$", mime: "application/pdf", pages: [4] }] }, deps(files, { transcriber: second.t }).d);
  assertEquals([second.calls.length, p?.triage.keptPages], [1, [4]]);
});

Deno.test("the vision daily cap is respected", async () => {
  const { t, calls } = fakeTranscriber("x 5 PM");
  const [r] = await triageMessage([att("flyer", { mime: "image/jpeg", filename: "flyer.jpg" })], null, deps({ "f/m/flyer": new Uint8Array(30_000) }, { transcriber: t, visionQuota: 0 }).d);
  assertEquals([r?.status, r?.triage.reason, calls.length], ["pending", "daily_vision_limit", 0]);
});

Deno.test("a refusal is recorded, not retried forever", async () => {
  const t: Transcriber = { transcribe: () => Promise.reject(new RefusedError("cyber")) };
  const [r] = await triageMessage([att("flyer", { mime: "image/jpeg", filename: "flyer.jpg" })], null, deps({ "f/m/flyer": new Uint8Array(30_000) }, { transcriber: t }).d);
  assertEquals([r?.status, r?.triage.reason], ["skipped", "vision_refused"]);
});

Deno.test("after one 'this one', the next email from that sender goes straight to the right file", async () => {
  // The rule choose_attachment() writes after the owner picks schedule-week-47.pdf:
  const rule = { version: 1, prefer: [{ pattern: "^schedule-week-\\d+\\.pdf$", mime: "application/pdf", pages: [] }] };
  const files = {
    "f/m/newsletter": await pdf([SCHEDULE_A, SCHEDULE_B]), // would otherwise win on dates
    "f/m/week48": await pdf([["Week 48", "Mon 5 PM practice", "Sat 9 AM game vs Otters"]]),
  };
  const results = await triageMessage([att("newsletter", { filename: "newsletter.pdf" }), att("week48", { filename: "Schedule-Week-48.pdf" })], rule, deps(files).d);
  assertEquals(results.map((r) => [r.status, r.triage.reason]), [["skipped", "rule_other"], ["text_layer", "text_layer"]]);
});

Deno.test("stage 1: unsupported, too big, unlikely name, seen before, and 'never' rules skip without reading", async () => {
  const { d } = deps({});
  const results = await triageMessage([
    att("doc", { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "notes.docx" }),
    att("huge", { bytes: 16 * 1024 * 1024 }),
    att("rcpt", { filename: "receipt-1042.pdf" }),
    att("again", { seen_before: true }),
    att("ad", { filename: "sponsor-ad-3.pdf" }),
  ], { version: 1, never: [{ pattern: "^sponsor-ad-\\d+\\.pdf$" }] }, d);
  assertEquals(results.map((r) => r.triage.reason), ["unsupported_type", "too_large", "unlikely_filename", "seen_before", "rule_never"]);
});

Deno.test("a calendar invite is always kept; a broken file fails without stopping the others", async () => {
  const ics = new TextEncoder().encode("BEGIN:VCALENDAR\nSUMMARY:Party\nEND:VCALENDAR");
  const results = await triageMessage([att("invite", { mime: "text/calendar", filename: "invite.ics" }), att("broken")], null, deps({ "f/m/invite": ics }).d);
  assertEquals(results.map((r) => r.status), ["text_layer", "failed"]);
});

Deno.test("vision token estimate follows the documented formula and cap", () => {
  assertEquals(estimateVisionTokens(1920, 1080), 69 * 39);
  assertEquals(estimateVisionTokens(4000, 3000), 4784);
  assertEquals(estimateVisionTokens(null, null), 4784);
});
