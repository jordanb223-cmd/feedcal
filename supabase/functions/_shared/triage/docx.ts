// D61: reads the text of a Word (.docx) file. A .docx is a zip archive; only word/document.xml is
// read. Built-in, no library: the zip directory is parsed by hand, decompression stops at a cap
// (so a "zip bomb" ends early), and the XML is walked once with indexOf (no regex that can stall,
// no DTD or entity expansion: only the five standard entities and numeric references are decoded).
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_XML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_ENTRIES = 2000;
const PAGE_CHARS = 3000;

export class DocxError extends Error {}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

function findEndOfDirectory(b: Uint8Array): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32(b, i) === 0x06054b50) return i;
  throw new DocxError("not_a_zip");
}

async function inflateCapped(data: Uint8Array, cap: number): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new DocxError("too_large");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e instanceof DocxError ? e : new DocxError("corrupt");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** The raw bytes of word/document.xml, or a DocxError. */
export async function documentXml(b: Uint8Array): Promise<Uint8Array> {
  if (b.length < 22 || u32(b, 0) !== 0x04034b50) throw new DocxError("not_a_zip");
  const eocd = findEndOfDirectory(b);
  const entries = u16(b, eocd + 10);
  const dirOffset = u32(b, eocd + 16);
  if (entries === 0xffff || dirOffset === 0xffffffff) throw new DocxError("zip64");
  if (entries > MAX_ENTRIES) throw new DocxError("too_many_files");
  let at = dirOffset;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > b.length || u32(b, at) !== 0x02014b50) throw new DocxError("corrupt");
    const flags = u16(b, at + 8), method = u16(b, at + 10);
    const compSize = u32(b, at + 20), size = u32(b, at + 24);
    const nameLen = u16(b, at + 28), extraLen = u16(b, at + 30), commentLen = u16(b, at + 32);
    const local = u32(b, at + 42);
    const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name !== "word/document.xml") continue;
    if (flags & 1) throw new DocxError("encrypted");
    if (compSize === 0xffffffff || size === 0xffffffff) throw new DocxError("zip64");
    if (size > MAX_XML_BYTES) throw new DocxError("too_large");
    if (local + 30 > b.length || u32(b, local) !== 0x04034b50) throw new DocxError("corrupt");
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    if (start + compSize > b.length) throw new DocxError("corrupt");
    const data = b.subarray(start, start + compSize);
    if (method === 0) return data;
    if (method === 8) return await inflateCapped(data, MAX_XML_BYTES);
    throw new DocxError("unsupported_compression");
  }
  throw new DocxError("no_document");
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] !== "#") return ENTITIES[e] ?? "";
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

/** Paragraph text from document.xml: one pass over the tags. Deleted text and field codes are left out. */
export function xmlToText(xml: string): string {
  let out = "";
  let skip = 0; // inside w:delText / w:instrText
  let at = 0;
  while (at < xml.length && out.length < MAX_TEXT) {
    const lt = xml.indexOf("<", at);
    if (lt < 0) { if (!skip) out += decodeEntities(xml.slice(at)); break; }
    if (lt > at && !skip) out += decodeEntities(xml.slice(at, lt));
    const gt = xml.indexOf(">", lt);
    if (gt < 0) break;
    const tag = xml.slice(lt + 1, gt);
    const close = tag.startsWith("/");
    const name = (close ? tag.slice(1) : tag).split(/[\s/]/, 1)[0] ?? "";
    if (name === "w:delText" || name === "w:instrText") skip = close ? Math.max(0, skip - 1) : tag.endsWith("/") ? skip : skip + 1;
    else if (close && name === "w:p") out += "\n";
    else if (close && name === "w:tc") out += "\t";
    else if (!close && (name === "w:tab")) out += "\t";
    else if (!close && (name === "w:br" || name === "w:cr")) out += "\n";
    at = gt + 1;
  }
  // Linear clean-up: trim each line's end, then collapse runs of blank lines. (A regex like
  // /[ \t]+\n/ retried from every tab and took 13 s on a document of tabs; the tests caught it.)
  const lines = out.slice(0, MAX_TEXT).split("\n").map((l) => l.trimEnd());
  const kept: string[] = [];
  for (const l of lines) if (l || (kept.length && kept[kept.length - 1])) kept.push(l);
  return kept.join("\n").trim();
}

/** The document's text split into pages of about 3,000 characters, at paragraph breaks. */
export async function docxPages(bytes: Uint8Array): Promise<string[]> {
  const xml = new TextDecoder().decode(await documentXml(bytes));
  const text = xmlToText(xml);
  const pages: string[] = [];
  let page = "";
  for (const para of text.split("\n")) {
    if (page && page.length + para.length + 1 > PAGE_CHARS) { pages.push(page); page = ""; }
    page = page ? `${page}\n${para}` : para.slice(0, PAGE_CHARS * 2);
  }
  if (page) pages.push(page);
  return pages;
}

/** True when the bytes really are the claimed type (an upload's label can't be trusted). */
export function bytesMatchType(mime: string, b: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  switch (mime) {
    case "application/pdf": return starts(0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
    case DOCX_MIME: return starts(0x50, 0x4b, 0x03, 0x04);                // PK..
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38);
    case "image/webp": return starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    case "text/plain": case "text/csv": case "text/calendar":
      return !b.subarray(0, 8192).includes(0) && new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096)).length > 0;
    default: return false;
  }
}
