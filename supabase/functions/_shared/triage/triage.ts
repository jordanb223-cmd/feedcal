// Phase 8: decide, per attachment and cheapest step first, which pages the AI should read.
//   Stage 0  the owner's learned rule for this sender (prefer / never)
//   Stage 1  metadata: type, size, filename, page count, "seen before"
//   Stage 2  PDF text layer: score every page, keep the best (max 5 per message)
//   Stage 3  (Phase 9) the AI reads only those pages
//   Stage 4  images and scanned pages last: a vision model transcribes them, if configured
// Pure apart from the injected readFile / transcriber / quota, so every rule is unit-tested.
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { extractText, getDocumentProxy } from "npm:unpdf@2.1.0";
import { isNever, preferredMatch, readRule } from "./rule.ts";
import { KEEP_THRESHOLD, scorePage, type PageScore } from "./score.ts";
import { PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN, RefusedError, type Transcriber, type TranscribeInput } from "./transcriber.ts";

export const PAGES_PER_MESSAGE = 5;
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_PAGES = 40;
export const MAX_VISION_BYTES = 7 * 1024 * 1024; // 10 MB base64 per image (Claude vision docs)
const MAX_SCANNED_PAGES = 2;
const MAX_VISION_TOKENS = 4784; // high-resolution tier cap per image (Claude vision docs)
const SCANNED_CHARS_PER_PAGE = 40;
export const PDF_PARSE_MS = 20_000; // per file (D37)

const TEXT_TYPES = new Set(["text/plain", "text/calendar", "text/csv"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const UNLIKELY_NAME = /(receipt|invoice|unsubscribe|w-?9|tax[ _-]?form|privacy[ _-]?policy|terms)/i;

export interface AttachmentIn {
  id: string;
  filename: string | null;
  mime: string;
  bytes: number;
  storage_path: string | null;
  status: string;
  chosen: boolean;
  width: number | null;
  height: number | null;
  seen_before: boolean;
  /** The owner said "never use files like this" about this very file. */
  owner_never: boolean;
}

export interface KeptPage { index: number; text: string; source: "text_layer" | "transcription" }

export interface AttachmentResult {
  id: string;
  status: "pending" | "skipped" | "text_layer" | "transcribed" | "failed";
  pages: KeptPage[];
  pages_total: number | null;
  triage: {
    stage: 0 | 1 | 2 | 4;
    reason: string;
    keptPages?: number[];
    scores?: PageScore[];
    visionTokens?: { input: number; output: number };
    costUsd?: number;
  };
}

export interface TriageDeps {
  readFile(path: string): Promise<Uint8Array>;
  transcriber?: Transcriber;
  /** Grants up to `wanted` units of today's allowance for this feed's owner. */
  quota(kind: "text_pages" | "vision_pages", wanted: number): Promise<number>;
}

interface Candidate { att: AttachmentIn; preferredPages: number[] | null; preferred: boolean }

function skip(att: AttachmentIn, stage: 0 | 1 | 2 | 4, reason: string, extra: Partial<AttachmentResult> = {}): AttachmentResult {
  return { id: att.id, status: "skipped", pages: [], pages_total: null, triage: { stage, reason }, ...extra };
}

/**
 * Phase 16 (D37): files we refuse to open. Not a PDF at all (despite its type), or encrypted
 * (a password-protected file can't be read reliably, and pdf.js would need its password).
 * Embedded JavaScript is never run: text extraction doesn't execute scripts, and a page sent
 * to vision is copied into a fresh document, which leaves the original's scripts behind.
 */
export function pdfRefusal(bytes: Uint8Array): "malformed" | "encrypted" | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) return "malformed";
  // The /Encrypt entry lives in the trailer or the cross-reference stream's dictionary, which
  // are never compressed, so a plain search finds it.
  const all = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(all)) return "encrypted";
  return null;
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await withTimeout(extractText(pdf, { mergePages: false }), PDF_PARSE_MS);
    return (text as string[]).map((t) => t.replace(/[ \t]+/g, " ").trim());
  } finally {
    await pdf.loadingTask.destroy().catch(() => {}); // free the parser's memory now, not at the end of the run
  }
}

async function singlePagePdf(bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [index]);
  out.addPage(page!);
  return out.save();
}

export async function triageMessage(attachments: AttachmentIn[], ruleValue: unknown, deps: TriageDeps): Promise<AttachmentResult[]> {
  const rule = readRule(ruleValue);
  const results = new Map<string, AttachmentResult>();
  const live = attachments.filter((a) => !(a.owner_never && a.status === "skipped") || a.chosen);

  // ---- Stage 0: the owner's rule. A preferred match wins outright; "never" always applies.
  const candidates: Candidate[] = [];
  const preferredAny = live.some((a) => preferredMatch(rule, a.filename, a.mime) || a.chosen);
  for (const att of attachments) {
    if (!live.includes(att)) { results.set(att.id, skip(att, 0, "owner_never")); continue; }
    if (isNever(rule, att.filename, att.mime) && !att.chosen) { results.set(att.id, skip(att, 0, "rule_never")); continue; }
    const pref = preferredMatch(rule, att.filename, att.mime);
    if (preferredAny && !pref && !att.chosen) { results.set(att.id, skip(att, 0, "rule_other")); continue; }
    candidates.push({ att, preferredPages: pref?.pages?.length ? pref.pages : null, preferred: Boolean(pref || att.chosen) });
  }

  // ---- Stage 1: metadata, no file reads.
  const readable: Candidate[] = [];
  for (const c of candidates) {
    const { att } = c;
    const known = att.mime === "application/pdf" || TEXT_TYPES.has(att.mime) || IMAGE_TYPES.has(att.mime);
    if (!known) { results.set(att.id, skip(att, 1, "unsupported_type")); continue; }
    if (!att.storage_path) { results.set(att.id, skip(att, 1, "no_file")); continue; }
    if (att.bytes > MAX_BYTES && !rule.allowLarge) { results.set(att.id, skip(att, 1, "too_large")); continue; }
    if (!c.preferred && att.filename && UNLIKELY_NAME.test(att.filename)) { results.set(att.id, skip(att, 1, "unlikely_filename")); continue; }
    if (!c.preferred && att.seen_before) { results.set(att.id, skip(att, 1, "seen_before")); continue; }
    readable.push(c);
  }

  // ---- Stage 2: text. Score every page; pick the best across the message, up to 5.
  interface Scored { c: Candidate; pages: string[]; scores: PageScore[] }
  const scored: Scored[] = [];
  const visionQueue: { c: Candidate; total: number | null; pages?: number[] }[] = [];
  for (const c of readable) {
    const { att } = c;
    if (IMAGE_TYPES.has(att.mime)) { visionQueue.push({ c, total: 1 }); continue; }
    let pages: string[];
    try {
      const bytes = await deps.readFile(att.storage_path!);
      const refusal = TEXT_TYPES.has(att.mime) ? null : pdfRefusal(bytes);
      if (refusal) {
        results.set(att.id, { id: att.id, status: "failed", pages: [], pages_total: null, triage: { stage: 2, reason: refusal } });
        continue;
      }
      pages = TEXT_TYPES.has(att.mime) ? [new TextDecoder().decode(bytes).slice(0, 50_000)] : await pdfPages(bytes);
    } catch (e) {
      const reason = e instanceof Error && e.message === "timeout" ? "too_slow" : "unreadable";
      results.set(att.id, { id: att.id, status: "failed", pages: [], pages_total: null, triage: { stage: 2, reason } });
      continue;
    }
    if (pages.length > MAX_PAGES && !rule.allowLarge) { results.set(att.id, skip(att, 1, "too_many_pages", { pages_total: pages.length })); continue; }
    const textChars = pages.reduce((n, p) => n + p.length, 0);
    if (att.mime === "application/pdf" && textChars < SCANNED_CHARS_PER_PAGE * pages.length) {
      // No usable text layer: a scan. Only the preferred pages, or the first couple, go to vision.
      const wanted = (c.preferredPages ?? [...Array(Math.min(MAX_SCANNED_PAGES, pages.length)).keys()]).filter((i) => i < pages.length);
      visionQueue.push({ c, total: pages.length, pages: wanted.slice(0, MAX_SCANNED_PAGES) });
      continue;
    }
    scored.push({ c, pages, scores: pages.map((t, i) => scorePage(i, t)) });
  }

  // Preferred pages first, then calendar files, then the highest scores above the threshold.
  const picks: { s: Scored; index: number; rank: number }[] = [];
  for (const s of scored) {
    s.scores.forEach((sc) => {
      const preferredPage = s.c.preferredPages?.includes(sc.index) ?? false;
      const isCalendar = s.c.att.mime === "text/calendar";
      const eligible = preferredPage || isCalendar || sc.score >= KEEP_THRESHOLD || (s.c.preferred && !s.c.preferredPages);
      if (eligible) picks.push({ s, index: sc.index, rank: (preferredPage ? 1000 : 0) + (isCalendar ? 500 : 0) + (s.c.preferred ? 100 : 0) + sc.score });
    });
  }
  picks.sort((a, b) => b.rank - a.rank || a.index - b.index);
  let budget = PAGES_PER_MESSAGE;
  const granted = await deps.quota("text_pages", Math.min(budget, picks.length));
  const chosen = picks.slice(0, granted);
  budget -= chosen.length;
  const overQuota = picks.length > 0 && granted < Math.min(PAGES_PER_MESSAGE, picks.length);
  for (const s of scored) {
    const mine = chosen.filter((p) => p.s === s).map((p) => p.index).sort((a, b) => a - b);
    const triage = { stage: 2 as const, reason: mine.length ? "text_layer" : overQuota ? "daily_page_limit" : "no_schedule_found", keptPages: mine, scores: s.scores };
    results.set(s.c.att.id, mine.length
      ? { id: s.c.att.id, status: "text_layer", pages: mine.map((i) => ({ index: i, text: s.pages[i]!, source: "text_layer" as const })), pages_total: s.pages.length, triage }
      : { id: s.c.att.id, status: "skipped", pages: [], pages_total: s.pages.length, triage });
  }

  // ---- Stage 4: images and scans, last and only within what's left.
  visionQueue.sort((a, b) => Number(b.c.preferred) - Number(a.c.preferred));
  for (const v of visionQueue) {
    const { att } = v.c;
    const pageIndexes = v.pages ?? [0];
    if (!deps.transcriber) {
      results.set(att.id, { id: att.id, status: "pending", pages: [], pages_total: v.total, triage: { stage: 4, reason: "needs_vision_not_configured" } });
      continue;
    }
    if (budget <= 0) { results.set(att.id, skip(att, 4, "page_budget_used", { pages_total: v.total })); continue; }
    if (att.bytes > MAX_VISION_BYTES && IMAGE_TYPES.has(att.mime)) { results.set(att.id, skip(att, 4, "too_large_for_vision", { pages_total: v.total })); continue; }
    const wanted = pageIndexes.slice(0, budget);
    const allowed = await deps.quota("vision_pages", wanted.length);
    if (allowed === 0) { results.set(att.id, { id: att.id, status: "pending", pages: [], pages_total: v.total, triage: { stage: 4, reason: "daily_vision_limit" } }); continue; }
    try {
      const bytes = await deps.readFile(att.storage_path!);
      const kept: KeptPage[] = [];
      let input = 0;
      let output = 0;
      for (const index of wanted.slice(0, allowed)) {
        const request: TranscribeInput = IMAGE_TYPES.has(att.mime)
          ? { kind: "image", mime: att.mime as "image/jpeg", bytes }
          : { kind: "pdf_page", bytes: await singlePagePdf(bytes, index) };
        const t = await deps.transcriber.transcribe(request);
        input += t.inputTokens;
        output += t.outputTokens;
        if (t.text) kept.push({ index, text: t.text, source: "transcription" });
      }
      budget -= kept.length;
      const costUsd = Math.round((input * PRICE_PER_INPUT_TOKEN + output * PRICE_PER_OUTPUT_TOKEN) * 10000) / 10000;
      results.set(att.id, {
        id: att.id,
        status: kept.length ? "transcribed" : "skipped",
        pages: kept,
        pages_total: v.total,
        triage: { stage: 4, reason: kept.length ? "transcribed" : "no_text_on_page", keptPages: kept.map((k) => k.index), visionTokens: { input, output }, costUsd },
      });
    } catch (e) {
      const reason = e instanceof RefusedError ? "vision_refused" : "vision_failed";
      results.set(att.id, { id: att.id, status: e instanceof RefusedError ? "skipped" : "failed", pages: [], pages_total: v.total, triage: { stage: 4, reason } });
    }
  }

  return attachments.map((a) => results.get(a.id)!).filter(Boolean);
}

/** Estimated vision cost before calling, for logs: image tokens from its size, capped by the tier. */
export function estimateVisionTokens(width: number | null, height: number | null): number {
  if (!width || !height) return MAX_VISION_TOKENS;
  return Math.min(MAX_VISION_TOKENS, Math.ceil(width / 28) * Math.ceil(height / 28));
}
