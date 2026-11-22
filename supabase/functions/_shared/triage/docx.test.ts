// D61: the Word reader against real content and hostile files.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { bytesMatchType, DOCX_MIME, DocxError, docxPages, documentXml, xmlToText } from "./docx.ts";

const enc = new TextEncoder();
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}
interface Entry { name: string; data: Uint8Array; method?: 0 | 8 | 12; declaredSize?: number; flags?: number }
/** A minimal zip writer, so tests can build honest and dishonest archives. */
async function zip(entries: Entry[], opts: { dirOffset?: number; entryCount?: number } = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? await deflate(e.data) : e.data;
    const name = enc.encode(e.name);
    const size = e.declaredSize ?? e.data.length;
    const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(6, e.flags ?? 0, true); lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); local.set(name, 30);
    const dir = new Uint8Array(46 + name.length); const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(8, e.flags ?? 0, true); dv.setUint16(10, method, true);
    dv.setUint32(20, body.length, true); dv.setUint32(24, size, true); dv.setUint16(28, name.length, true); dv.setUint32(42, offset, true); dir.set(name, 46);
    parts.push(local, body); central.push(dir); offset += local.length + body.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, opts.entryCount ?? entries.length, true); ev.setUint16(10, opts.entryCount ?? entries.length, true);
  ev.setUint32(12, dirSize, true); ev.setUint32(16, opts.dirOffset ?? offset, true);
  const all = [...parts, ...central, end]; const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
const docXml = (body: string) => enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`);
const p = (...runs: string[]) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`;

Deno.test("reads paragraphs, tables, tabs, breaks and special characters", async () => {
  const xml = docXml(p("Picture day: ", "Fri, Dec 5") + p("Bring &amp; wear &lt;red&gt; &#x1F383; &#233;t&#233;") +
    `<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc>${p("Mon")}</w:tc><w:tc>${p("Practice 4pm")}</w:tc></w:tr></w:tbl>` +
    `<w:p><w:del><w:r><w:delText>Cancelled Dec 1</w:delText></w:r></w:del><w:r><w:instrText> HYPERLINK "http://x" </w:instrText><w:t>Concert Dec 12</w:t></w:r></w:p>`);
  const pages = await docxPages(await zip([{ name: "[Content_Types].xml", data: enc.encode("<x/>") }, { name: "word/document.xml", data: xml }]));
  const text = pages.join("\n");
  for (const want of ["Picture day: Fri, Dec 5", "Bring & wear <red> 🎃 été", "Line one\nLine two\ttabbed", "Mon", "Practice 4pm", "Concert Dec 12"]) assert(text.includes(want), `missing ${JSON.stringify(want)} in ${JSON.stringify(text)}`);
  for (const gone of ["Cancelled Dec 1", "HYPERLINK", "<w:", "&amp;"]) assert(!text.includes(gone), `should not contain ${gone}`);
});

Deno.test("stored (uncompressed) files work too, and long documents split into pages", async () => {
  const xml = docXml(Array.from({ length: 400 }, (_, i) => p(`Event ${i}: something on Dec ${(i % 28) + 1}`)).join(""));
  const pages = await docxPages(await zip([{ name: "word/document.xml", data: xml, method: 0 }]));
  assert(pages.length > 3, `expected several pages, got ${pages.length}`);
  for (const page of pages) assert(page.length <= 6000);
  assert(pages.join("\n").includes("Event 399"));
});

Deno.test("hostile archives are refused quickly", async () => {
  const zeros = new Uint8Array(50 * 1024 * 1024);
  const cases: [string, Promise<Uint8Array>, string][] = [
    ["zip bomb that lies about its size", zip([{ name: "word/document.xml", data: zeros, declaredSize: 100 }]), "too_large"],
    ["zip bomb that tells the truth", zip([{ name: "word/document.xml", data: zeros }]), "too_large"],
    ["encrypted", zip([{ name: "word/document.xml", data: docXml(p("x")), flags: 1 }]), "encrypted"],
    ["no document inside", zip([{ name: "word/other.xml", data: docXml(p("x")) }]), "no_document"],
    ["unknown compression", zip([{ name: "word/document.xml", data: docXml(p("x")), method: 12 }]), "unsupported_compression"],
    ["directory points outside the file", zip([{ name: "word/document.xml", data: docXml(p("x")) }], { dirOffset: 99_999_999 }), "corrupt"],
    ["too many files", zip(Array.from({ length: 2100 }, (_, i) => ({ name: `f${i}`, data: enc.encode("x"), method: 0 as const }))), "too_many_files"],
    ["zip64 marker", zip([{ name: "word/document.xml", data: docXml(p("x")) }], { entryCount: 0xffff }), "zip64"],
  ];
  for (const [label, file, reason] of cases) {
    const t0 = performance.now();
    const err = await assertRejects(async () => documentXml(await file), DocxError);
    assertEquals(err.message, reason, label);
    assert(performance.now() - t0 < 5000, `${label} took ${(performance.now() - t0).toFixed(0)} ms`);
  }
  for (const junk of [new Uint8Array(0), enc.encode("not a zip at all"), enc.encode("PK\x03\x04garbage"), (await zip([{ name: "word/document.xml", data: docXml(p("x")) }])).slice(0, 40)]) {
    await assertRejects(() => documentXml(junk), DocxError);
  }
  // A real deflate stream cut short is "corrupt", not a crash.
  const good = await zip([{ name: "word/document.xml", data: docXml(p("hello ".repeat(5000))) }]);
  const broken = good.slice(); broken.fill(0xff, 60, 400);
  await assertRejects(() => documentXml(broken), DocxError);
});

Deno.test("hostile XML can't make the reader slow", () => {
  const big = 5 * 1024 * 1024;
  for (const unit of ["<", "<w:t", "<w:p", "&", "&#", "&#x", "</w:p>", "<w:delText>", "<w:tab/>", "<<>>", "x"]) {
    const xml = unit.repeat(Math.ceil(big / unit.length));
    const t0 = performance.now(); xmlToText(xml); const ms = performance.now() - t0;
    assert(ms < 2000, `${JSON.stringify(unit)} x 5 MB took ${ms.toFixed(0)} ms`);
  }
});

Deno.test("a file must really be the type it claims", () => {
  const pdf = enc.encode("%PDF-1.7\n..."), png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const gif = enc.encode("GIF89a"), webp = enc.encode("RIFF\x00\x00\x00\x00WEBPVP8 "), docx = enc.encode("PK\x03\x04rest"), exe = enc.encode("MZ\x90\x00"), html = enc.encode("<html><script>");
  assert(bytesMatchType("application/pdf", pdf) && bytesMatchType("image/png", png) && bytesMatchType("image/jpeg", jpg) && bytesMatchType("image/gif", gif));
  assert(bytesMatchType("image/webp", webp) && bytesMatchType(DOCX_MIME, docx) && bytesMatchType("text/plain", enc.encode("Picture day Dec 5")));
  for (const [mime, bytes] of [["application/pdf", exe], ["application/pdf", html], ["image/png", jpg], ["image/jpeg", pdf], [DOCX_MIME, pdf], ["image/webp", enc.encode("RIFF\x00\x00\x00\x00WAVE")],
    ["text/plain", new Uint8Array([0x41, 0, 0x42])], ["application/x-msdownload", exe], ["text/html", html]] as [string, Uint8Array][]) {
    assert(!bytesMatchType(mime, bytes), `${mime} accepted ${new TextDecoder().decode(bytes.slice(0, 8))}`);
  }
});
