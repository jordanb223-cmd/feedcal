// Phase 7: one raw email in, one ParsedMessage (plus the attachment bytes to store) out.
// Pure: no network, no database. Every rule here is covered by fixtures/ (parse.test.ts).
import PostalMime from "npm:postal-mime@4.2.0";
import { headerOffset, parseLooseDate, parseSender, stripQuotes, unwrapForwards } from "./forward.ts";
import { htmlToText, tidy } from "./html-to-text.ts";
import { decideAttachment } from "./images.ts";
import { detectLanguage } from "./language.ts";
import { ParsedMessage, type ParsedAttachment } from "./types.ts";

export interface AttachmentFile { sha256: string; mime: string; filename: string | null; content: Uint8Array }
export interface ParseResult { parsed: ParsedMessage; files: AttachmentFile[] }

const MAX_TEXT = 100_000;
const NOT_A_REAL_TEXT_PART = /view (this|it|the)( e-?mail| message| newsletter)? (online|in (your|a) (web )?browser)|does(n't| not) support html|html version/i;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array();
}

/** Prefer text/plain, unless it's a stub ("view in browser") or far shorter than the HTML. */
function chooseBody(text: string | undefined, html: string | undefined): { body: string; source: "text" | "html" | "none" } {
  const plain = tidy(text ?? "");
  const fromHtml = html ? htmlToText(html) : "";
  if (plain && !(fromHtml && (NOT_A_REAL_TEXT_PART.test(plain) && plain.length < 400 || plain.length < fromHtml.length * 0.2))) {
    return { body: plain, source: "text" };
  }
  if (fromHtml) return { body: fromHtml, source: "html" };
  return { body: "", source: "none" };
}

export async function parseMessage(raw: Uint8Array | string, opts: { receivedAt: string }, depth = 0): Promise<ParseResult> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const dateHeader = email.headers.find((h) => h.key === "date")?.value ?? null;
  const fallbackOffset = headerOffset(dateHeader) ?? 0;
  const { body, source } = chooseBody(email.text, email.html);

  // Outlook's "Forward as attachment": the original arrives as a message/rfc822 part.
  const enclosed = email.attachments.filter((a) => a.mimeType === "message/rfc822");
  if (enclosed.length === 1 && depth < 3 && stripQuotes(body).clean.length < 1000) {
    const inner = await parseMessage(toBytes(enclosed[0]!.content), opts, depth + 1);
    const others = await collectAttachments(email.attachments.filter((a) => a !== enclosed[0]));
    const note = stripQuotes(body).clean;
    const parsed = ParsedMessage.parse({
      ...inner.parsed,
      forwardNotes: [...(note ? [note] : []), ...inner.parsed.forwardNotes].slice(0, 10),
      forwardDepth: Math.min(inner.parsed.forwardDepth + 1, 10),
      attachments: [...inner.parsed.attachments, ...others.kept].slice(0, 50),
      discarded: [...inner.parsed.discarded, ...others.discarded].slice(0, 200),
    });
    return { parsed, files: dedupeFiles([...inner.files, ...others.files]) };
  }

  const unwrapped = unwrapForwards(body, email.subject ?? null);
  const { clean, stripped } = stripQuotes(unwrapped.body);
  const forwardedDate = parseLooseDate(unwrapped.headers?.date ?? null, fallbackOffset);
  const referenceDate = forwardedDate ?? email.date ?? opts.receivedAt;
  const referenceDateSource = forwardedDate ? "forwarded_header" : email.date ? "date_header" : "received";
  const forwardedSender = parseSender(unwrapped.headers?.from ?? null);
  const sender = forwardedSender ?? (email.from?.address ? { address: email.from.address.toLowerCase(), name: email.from.name || null } : null);
  const subject = (unwrapped.headers?.subject ?? email.subject ?? null)?.replace(/^\s*((fw|fwd|re)\s*:\s*)+/i, "").trim() || null;
  const attachments = await collectAttachments(email.attachments);

  const parsed = ParsedMessage.parse({
    version: 1,
    referenceDate: new Date(referenceDate).toISOString(),
    referenceDateSource,
    sender,
    subject: subject?.slice(0, 998) ?? null,
    cleanText: clean.slice(0, MAX_TEXT),
    strippedText: stripped.slice(0, MAX_TEXT),
    forwardNotes: unwrapped.notes.map((n) => n.slice(0, 10_000)).slice(0, 10),
    forwardDepth: unwrapped.depth,
    bodySource: source,
    language: detectLanguage(clean),
    attachments: attachments.kept.slice(0, 50),
    discarded: attachments.discarded.slice(0, 200),
  });
  return { parsed, files: attachments.files };
}

function dedupeFiles(files: AttachmentFile[]): AttachmentFile[] {
  const seen = new Set<string>();
  return files.filter((f) => (seen.has(f.sha256) ? false : (seen.add(f.sha256), true)));
}

// deno-lint-ignore no-explicit-any
async function collectAttachments(list: any[]) {
  const kept: ParsedAttachment[] = [];
  const discarded: ParsedMessage["discarded"] = [];
  const files: AttachmentFile[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const content = toBytes(a.content);
    const mime = String(a.mimeType || "application/octet-stream").toLowerCase().slice(0, 255);
    const filename = a.filename ? String(a.filename).slice(0, 255) : null;
    const decision = decideAttachment(mime, filename, content);
    if (!decision.keep) {
      discarded.push({ filename, mime, bytes: content.length, reason: decision.reason as ParsedMessage["discarded"][number]["reason"] });
      continue;
    }
    const sha256 = await sha256Hex(content);
    if (seen.has(sha256)) continue; // the same file attached twice
    seen.add(sha256);
    kept.push({
      filename, mime, bytes: content.length, sha256,
      inline: a.disposition === "inline" || Boolean(a.related),
      contentId: a.contentId ? String(a.contentId).replace(/[<>]/g, "").slice(0, 255) : null,
      width: decision.size?.width || null,
      height: decision.size?.height || null,
    });
    files.push({ sha256, mime, filename, content });
  }
  return { kept, discarded, files };
}
