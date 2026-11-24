// Phase 8 "passes when": a 40-page newsletter sends only its schedule pages to the AI (D74: no page cap); a flyer photo's
// transcription holds its events (here with a fake transcriber: no paid API in tests); and a
// learned "this one" rule sends the next email straight to the right file.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { scorePage } from "./score.ts";
import { RefusedError, type Transcriber, type TranscribeInput } from "./transcriber.ts";
import { type AttachmentIn, estimateVisionTokens, pdfRefusal, triageMessage, type TriageDeps, withTimeout } from "./triage.ts";

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
      return { text: typeof text === "string" ? text : text(input), inputTokens: 1500, outputTokens: 120, model: "fake", costUsd: 0.0084 };
    },
  };
  return { t, calls };
}

/** D61: fixtures start with a real JPEG header, since triage now checks a file is what it claims. */
const jpeg = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };

Deno.test("scoring: a schedule page beats a page of prose", () => {
  assert(scorePage(0, SCHEDULE_A.join("\n")).score >= 3);
  assert(scorePage(1, PROSE.join("\n")).score < 3);
});

Deno.test("a 40-page newsletter sends only its schedule pages", async () => {
  const pages = Array.from({ length: 40 }, (_, i) => (i === 16 ? SCHEDULE_A : i === 17 ? SCHEDULE_B : PROSE));
  const { d, asked } = deps({ "f/m/newsletter": await pdf(pages) });
  const [r] = await triageMessage([att("newsletter")], null, d);
  assertEquals(r?.status, "text_layer");
  assertEquals(r?.pages_total, 40);
  assertEquals(r?.triage.keptPages, [16, 17]);
  assert(r?.pages[0]?.text.includes("Picture day"));
  assertEquals(r?.triage.scores?.length, 40);
  assertEquals(asked, [{ kind: "text_pages", wanted: 2 }]);
});

Deno.test("D74: a long file is read however many pages it has", async () => {
  const pages = Array.from({ length: 41 }, (_, i) => (i === 3 ? SCHEDULE_A : PROSE));
  const [read] = await triageMessage([att("big")], null, deps({ "f/m/big": await pdf(pages) }).d);
  assertEquals([read?.status, read?.triage.keptPages, read?.pages_total], ["text_layer", [3], 41]);
});

Deno.test("D74: every page that holds dates is kept; there is no five-page cap", async () => {
  const many = Array.from({ length: 4 }, () => SCHEDULE_A);
  const files = { "f/m/a": await pdf(many), "f/m/b": await pdf([...many, PROSE]) };
  const results = await triageMessage([att("a"), att("b")], null, deps(files).d);
  assertEquals(results.reduce((n, r) => n + r.pages.length, 0), 8);
});

Deno.test("D74: at most 30 pages are read from one file, unless the sender is marked for large files", async () => {
  const dates = Array.from({ length: 34 }, () => SCHEDULE_A);
  const text = { "f/m/long": await pdf(dates) };
  const [capped] = await triageMessage([att("long")], null, deps(text).d);
  assertEquals([capped?.status, capped?.pages.length, capped?.pages_total], ["text_layer", 30, 34]);
  const [all] = await triageMessage([att("long")], { version: 1, allowLarge: true }, deps(text).d);
  assertEquals(all?.pages.length, 34);

  const scan = { "f/m/scan": await pdf(Array.from({ length: 33 }, () => [""])) };
  const reader = fakeTranscriber("Practice Tuesdays 5 PM");
  const [s] = await triageMessage([att("scan")], null, deps(scan, { transcriber: reader.t, visionQuota: 100 }).d);
  assertEquals([s?.pages_total, reader.calls.length, s?.triage.keptPages?.at(-1)], [33, 30, 29]);
});

Deno.test("D74: files from one email are read up to 15 MB, documents before pictures", async () => {
  const MB = 1024 * 1024;
  const { t, calls } = fakeTranscriber("Field day Friday, May 8 at 9 AM");
  const files = { "f/m/photo1": jpeg(100), "f/m/photo2": jpeg(100), "f/m/news": await pdf([SCHEDULE_A]) };
  const results = await triageMessage([
    att("photo1", { mime: "image/jpeg", filename: "photo1.jpg", bytes: 6 * MB }),
    att("photo2", { mime: "image/jpeg", filename: "photo2.jpg", bytes: 6 * MB }),
    att("news", { filename: "newsletter.pdf", bytes: 5 * MB }),
  ], null, deps(files, { transcriber: t }).d);
  const by = Object.fromEntries(results.map((r) => [r.id, [r.status, r.triage.reason]]));
  assertEquals(by.news, ["text_layer", "text_layer"], "the newsletter is read first although it came last");
  assertEquals(by.photo1, ["transcribed", "transcribed"]);
  assertEquals(by.photo2, ["skipped", "size_budget_used"], "5 + 6 + 6 MB is over 15");
  assertEquals(calls.length, 1);
});

Deno.test("D74: with a short daily limit, a scanned newsletter is read before the photos", async () => {
  const { t, calls } = fakeTranscriber("Field day Friday, May 8 at 9 AM");
  const files = { "f/m/photo": jpeg(100), "f/m/scan": await pdf([[""]]) };
  const results = await triageMessage([att("photo", { mime: "image/jpeg", filename: "photo.jpg" }), att("scan")], null, deps(files, { transcriber: t, visionQuota: 1 }).d);
  const by = Object.fromEntries(results.map((r) => [r.id, [r.status, r.triage.reason]]));
  assertEquals([by.scan, by.photo, calls[0]?.kind], [["transcribed", "transcribed"], ["pending", "daily_vision_limit"], "pdf_page"]);
});

Deno.test("D76: on a retry, a picture already found to be blank is not read again", async () => {
  const { t, calls } = fakeTranscriber("x");
  const results = await triageMessage([att("blank", { mime: "image/jpeg", filename: "blank.jpg", status: "skipped", blank_before: true })], null, deps({ "f/m/blank": jpeg(100) }, { transcriber: t }).d);
  assertEquals([results.length, calls.length], [0, 0]);
});

Deno.test("D74: on a retry, a picture that was already read is left as it is and not paid for again", async () => {
  const { t, calls } = fakeTranscriber("Field day Friday, May 8 at 9 AM");
  const files = { "f/m/done": jpeg(100), "f/m/new": jpeg(100) };
  const results = await triageMessage([
    att("done", { mime: "image/jpeg", filename: "done.jpg", status: "transcribed" }),
    att("new", { mime: "image/jpeg", filename: "new.jpg", status: "skipped" }),
  ], null, deps(files, { transcriber: t }).d);
  assertEquals(results.map((r) => r.id), ["new"], "no result for the one already read, so its stored pages stay");
  assertEquals(calls.length, 1);
});

Deno.test("a flyer photo is transcribed (vision last), and its events are in the transcription", async () => {
  const flyer = "FALL FESTIVAL\nSaturday, October 18 | 11 AM - 3 PM\nOak Street School field\nPie contest at 1 PM";
  const { t, calls } = fakeTranscriber(flyer);
  const files = { "f/m/flyer": jpeg(300_000) };
  const [r] = await triageMessage([att("flyer", { filename: "fall-festival-flyer.jpg", mime: "image/jpeg", bytes: 300_000, width: 1200, height: 1600 })], null, deps(files, { transcriber: t }).d);
  assertEquals(r?.status, "transcribed");
  assertEquals(r?.pages, [{ index: 0, text: flyer, source: "transcription" }]);
  assert(r?.pages[0]?.text.includes("Saturday, October 18 | 11 AM - 3 PM"), "the event's quote is findable in the stored text");
  assertEquals(calls[0]?.kind, "image");
  assertEquals(r?.triage.visionTokens, { input: 1500, output: 120 });
  assertEquals(r?.triage.costUsd, 0.0084); // what the transcriber reported
});

Deno.test("without a vision key, images wait (pending) instead of failing", async () => {
  const [r] = await triageMessage([att("flyer", { mime: "image/png", filename: "flyer.png" })], null, deps({ "f/m/flyer": new Uint8Array(10) }).d);
  assertEquals([r?.status, r?.triage.reason], ["pending", "needs_vision_not_configured"]);
});

Deno.test("a scanned PDF sends every page to vision (D74), or only the page the owner chose", async () => {
  const blank = Array.from({ length: 6 }, () => [""]);
  const files = { "f/m/scan": await pdf(blank) };
  const first = fakeTranscriber("Practice Tuesdays 5 PM");
  const [r] = await triageMessage([att("scan")], null, deps(files, { transcriber: first.t }).d);
  assertEquals([r?.status, r?.pages_total, first.calls.length, first.calls[0]?.kind], ["transcribed", 6, 6, "pdf_page"]);
  const second = fakeTranscriber("Game day schedule");
  const [p] = await triageMessage([att("scan")], { version: 1, prefer: [{ pattern: "^scan\\.pdf$", mime: "application/pdf", pages: [4] }] }, deps(files, { transcriber: second.t }).d);
  assertEquals([second.calls.length, p?.triage.keptPages], [1, [4]]);
});

Deno.test("the vision daily cap is respected", async () => {
  const { t, calls } = fakeTranscriber("x 5 PM");
  const [r] = await triageMessage([att("flyer", { mime: "image/jpeg", filename: "flyer.jpg" })], null, deps({ "f/m/flyer": jpeg(30_000) }, { transcriber: t, visionQuota: 0 }).d);
  assertEquals([r?.status, r?.triage.reason, calls.length], ["pending", "daily_vision_limit", 0]);
});

Deno.test("a refusal is recorded, not retried forever", async () => {
  const t: Transcriber = { transcribe: () => Promise.reject(new RefusedError("cyber")) };
  const [r] = await triageMessage([att("flyer", { mime: "image/jpeg", filename: "flyer.jpg" })], null, deps({ "f/m/flyer": jpeg(30_000) }, { transcriber: t }).d);
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
    att("doc", { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "notes.xlsx" }), // Word is read since D61
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

Deno.test("unsafe PDFs are refused before parsing: not really a PDF, or encrypted (D37)", async () => {
  const fake = new TextEncoder().encode("<html><script>alert(1)</script></html>");
  const real = await pdf([SCHEDULE_A]);
  const locked = new Uint8Array([...real, ...new TextEncoder().encode("\ntrailer\n<< /Size 9 /Root 1 0 R /Encrypt 8 0 R >>\n%%EOF")]);
  assertEquals(pdfRefusal(fake), "malformed");
  assertEquals(pdfRefusal(locked), "encrypted");
  assertEquals(pdfRefusal(real), null);
  const results = await triageMessage([att("fake"), att("locked"), att("ok")], null, deps({ "f/m/fake": fake, "f/m/locked": locked, "f/m/ok": real }).d);
  assertEquals(results.map((r) => [r.id, r.status, r.triage.reason]), [["fake", "failed", "type_mismatch"], ["locked", "failed", "encrypted"], ["ok", "text_layer", results[2]!.triage.reason]]);
});

Deno.test("a parse that runs too long is stopped (D37)", async () => {
  const never = new Promise<string>(() => {});
  let err = "";
  try { await withTimeout(never, 10); } catch (e) { err = (e as Error).message; }
  assertEquals(err, "timeout");
  assertEquals(await withTimeout(Promise.resolve("done"), 10), "done");
});

Deno.test("vision token estimate follows the documented formula and cap", () => {
  assertEquals(estimateVisionTokens(1920, 1080), 69 * 39);
  assertEquals(estimateVisionTokens(4000, 3000), 4784);
  assertEquals(estimateVisionTokens(null, null), 4784);
});

/** D61: a one-file .docx built in the test (stored, not compressed). */
function storedDocx(xml: string): Uint8Array {
  const enc = new TextEncoder(); const name = enc.encode("word/document.xml"); const data = enc.encode(xml);
  const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true); local.set(name, 30);
  const dir = new Uint8Array(46 + name.length); const dv = new DataView(dir.buffer);
  dv.setUint32(0, 0x02014b50, true); dv.setUint32(20, data.length, true); dv.setUint32(24, data.length, true); dv.setUint16(28, name.length, true); dir.set(name, 46);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, dir.length, true); ev.setUint32(16, local.length + data.length, true);
  const out = new Uint8Array(local.length + data.length + dir.length + end.length);
  out.set(local, 0); out.set(data, local.length); out.set(dir, local.length + data.length); out.set(end, local.length + data.length + dir.length);
  return out;
}

Deno.test("a Word file is read like a PDF with text (D61)", async () => {
  const docx = storedDocx('<w:document><w:body><w:p><w:r><w:t>Winter concert is on Thursday, December 11 at 6:30 PM in the gym.</w:t></w:r></w:p></w:body></w:document>');
  const [r] = await triageMessage([att("news", { filename: "December news.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx.length, chosen: true })],
    null, deps({ "f/m/news": docx }).d);
  assertEquals(r?.status, "text_layer");
  assert(r?.pages[0]?.text.includes("December 11 at 6:30 PM"));
});

Deno.test("a file that isn't what it claims is refused before reading (D61)", async () => {
  const exe = new TextEncoder().encode("MZ\x90\x00 pretending to be a PDF");
  const html = new TextEncoder().encode("%PDX<html><script>alert(1)</script>");
  const results = await triageMessage([att("exe", { chosen: true }), att("htm", { chosen: true })], null, deps({ "f/m/exe": exe, "f/m/htm": html }).d);
  assertEquals(results.map((r) => [r.id, r.status, r.triage.reason]), [["exe", "failed", "type_mismatch"], ["htm", "failed", "type_mismatch"]]);
});

// ---------------------------------------------------------------- D75: two-pass reading
import { CHECK_MODEL, dateFacts, FIRST_MODEL, mentionsWhen, type PageRead, RefusedError as Refused, TIEBREAK_MODEL, twoPassTranscriber } from "./transcriber.ts";

function reader(replies: Record<string, string | "refuse" | "throw">) {
  const calls: string[] = [];
  const read = (model: string): Promise<PageRead> => {
    calls.push(model);
    const r = replies[model];
    if (r === "throw") return Promise.reject(new Error("image input not supported"));
    return Promise.resolve({ text: r === "refuse" ? "" : (r ?? ""), inputTokens: 5000, outputTokens: 200, model, refused: r === "refuse" });
  };
  return { t: twoPassTranscriber(read), calls };
}
const PICTURE: TranscribeInput = { kind: "image", mime: "image/jpeg", bytes: jpeg(10) };

Deno.test("D75: a picture with no text, or no day or time, costs one small-model read", async () => {
  const none = reader({ [FIRST_MODEL]: "" });
  assertEquals([(await none.t.transcribe(PICTURE)).text, none.calls], ["", [FIRST_MODEL]]);
  const caption = reader({ [FIRST_MODEL]: "Room F loves science" });
  const r = await caption.t.transcribe(PICTURE);
  assertEquals([r.text, r.unsure, caption.calls, r.costUsd], ["Room F loves science", undefined, [FIRST_MODEL], 0.0006]); // 5000 × $0.10/M + 200 × $0.50/M
});

Deno.test("D75: a picture that shows a date is read again, and agreeing reads are trusted", async () => {
  const both = reader({ [FIRST_MODEL]: "Fall Festival - Sat, Oct 18 at 11 AM", [CHECK_MODEL]: "FALL FESTIVAL\nSaturday, October 18 | 11 AM" });
  const r = await both.t.transcribe(PICTURE);
  assertEquals([r.text, r.unsure, both.calls, r.model], ["FALL FESTIVAL\nSaturday, October 18 | 11 AM", undefined, [FIRST_MODEL, CHECK_MODEL], CHECK_MODEL]);
  assertEquals(r.costUsd, 0.0126); // 0.0006 + 5000 × $2/M + 200 × $10/M
});

Deno.test("D78: when the two reads disagree, a third model settles it; two that agree are enough", async () => {
  const sidesWithCheck = reader({ [FIRST_MODEL]: "Musical Dec 18 at 6 PM", [CHECK_MODEL]: "Musical Dec 16 at 6 PM", [TIEBREAK_MODEL]: "MUSICAL - Dec 16, 6:00 pm" });
  const a = await sidesWithCheck.t.transcribe(PICTURE);
  assertEquals([a.text, a.unsure, sidesWithCheck.calls], ["MUSICAL - Dec 16, 6:00 pm", undefined, [FIRST_MODEL, CHECK_MODEL, TIEBREAK_MODEL]]);
  assertEquals(a.costUsd, 0.0366); // 0.0006 + 0.012 + (5000 × $4/M + 200 × $20/M)
  const sidesWithFirst = reader({ [FIRST_MODEL]: "Musical Dec 18 at 6 PM", [CHECK_MODEL]: "Musical Dec 16 at 6 PM", [TIEBREAK_MODEL]: "Musical Dec 18 at 6 PM" });
  assertEquals((await sidesWithFirst.t.transcribe(PICTURE)).unsure, undefined);
});

Deno.test("D78: when all three read it differently, the page is marked unsure for the owner", async () => {
  const split = reader({ [FIRST_MODEL]: "Musical Dec 18 at 6 PM", [CHECK_MODEL]: "Musical Dec 16 at 6 PM", [TIEBREAK_MODEL]: "Musical Dec 10 at 6 PM" });
  const r = await split.t.transcribe(PICTURE);
  assertEquals([r.text, r.unsure], ["Musical Dec 10 at 6 PM", true]);
});

Deno.test("D78: a model that errors or declines is stood in for by another", async () => {
  for (const down of ["throw", "refuse"] as const) {
    // The small model is down: the other two read it and agree.
    const noFirst = reader({ [FIRST_MODEL]: down, [CHECK_MODEL]: "Picture day Fri Nov 21 at 8:30 AM", [TIEBREAK_MODEL]: "Picture day, Nov 21, 8:30 am" });
    const a = await noFirst.t.transcribe(PICTURE);
    assertEquals([a.unsure, noFirst.calls], [undefined, [FIRST_MODEL, CHECK_MODEL, TIEBREAK_MODEL]], down);
    // The check model is down: the third agrees with the first.
    const noCheck = reader({ [FIRST_MODEL]: "Picture day Fri Nov 21 at 8:30 AM", [CHECK_MODEL]: down, [TIEBREAK_MODEL]: "Picture day, Nov 21, 8:30 am" });
    assertEquals((await noCheck.t.transcribe(PICTURE)).unsure, undefined, down);
    // Only one model can read it: its text is kept, and the owner is asked to compare.
    const alone = reader({ [FIRST_MODEL]: down, [CHECK_MODEL]: "Picture day Fri Nov 21 at 8:30 AM", [TIEBREAK_MODEL]: down });
    const c = await alone.t.transcribe(PICTURE);
    assertEquals([c.text, c.unsure], ["Picture day Fri Nov 21 at 8:30 AM", true], down);
  }
  const none = reader({ [FIRST_MODEL]: "refuse", [CHECK_MODEL]: "throw", [TIEBREAK_MODEL]: "refuse" });
  let threw = false;
  try { await none.t.transcribe(PICTURE); } catch (e) { threw = e instanceof Refused; }
  assert(threw, "no model could read it: reported as before");
});

Deno.test("D78: a file is read whole or waits for tomorrow, never half", async () => {
  const { t, calls } = fakeTranscriber("Practice Tuesdays 5 PM");
  const files = { "f/m/scan": await pdf(Array.from({ length: 6 }, () => [""])) };
  const [r] = await triageMessage([att("scan")], null, deps(files, { transcriber: t, visionQuota: 4 }).d);
  assertEquals([r?.status, r?.triage.reason, calls.length], ["pending", "daily_vision_limit", 0]);
  const again = fakeTranscriber("Practice Tuesdays 5 PM");
  const [ok] = await triageMessage([att("scan")], null, deps(files, { transcriber: again.t, visionQuota: 100 }).d);
  assertEquals([ok?.status, again.calls.length], ["transcribed", 6]);
});

Deno.test("D75: dates and times are compared, not wording", () => {
  assertEquals(dateFacts("Sat, Oct 18 at 11 AM"), dateFacts("Saturday October 18th | 11:00 am"));
  assert(dateFacts("Dec 18") !== dateFacts("Dec 16"));
  assertEquals([mentionsWhen("See you Friday!"), mentionsWhen("Room F loves science")], [true, false]);
});

Deno.test("D75: an unsure page reaches triage's output marked as such", async () => {
  const day = reader({ [FIRST_MODEL]: "Musical Dec 18 at 6 PM", [CHECK_MODEL]: "Musical Dec 16 at 6 PM", [TIEBREAK_MODEL]: "Musical Dec 10 at 6 PM" });
  const [r] = await triageMessage([att("flyer", { mime: "image/jpeg", filename: "flyer.jpg" })], null, deps({ "f/m/flyer": jpeg(100) }, { transcriber: day.t }).d);
  assertEquals([r?.status, r?.pages[0]?.source], ["transcribed", "transcription_unsure"]);
});
