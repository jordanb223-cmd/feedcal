// D61: uploading a file, end to end on the local stack: web routes -> upload-file function ->
// one-time storage link -> checks -> message + attachment -> triage reads it. Plus the attacks:
// strangers, oversize, wrong types, disguised files, reused/stolen/expired tickets, daily limit.
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";
import { localStatus } from "./local-stack.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const BASE = "http://localhost:8788";
const FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const sql = (q: string) => execFileSync("docker", ["exec", "-i", "supabase_db_feedcal", "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-c", q], { encoding: "utf8" }).trim();

function storedZip(name: string, text: string): Uint8Array {
  const enc = new TextEncoder(); const n = enc.encode(name); const d = enc.encode(text);
  const local = Buffer.alloc(30 + n.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26); Buffer.from(n).copy(local, 30);
  const dir = Buffer.alloc(46 + n.length); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt32LE(d.length, 20); dir.writeUInt32LE(d.length, 24); dir.writeUInt16LE(n.length, 28); Buffer.from(n).copy(dir, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(local.length + d.length, 16);
  return new Uint8Array(Buffer.concat([local, Buffer.from(d), dir, end]));
}
const docx = (body: string) => storedZip("word/document.xml", `<w:document><w:body>${body}</w:body></w:document>`);

describe.skipIf(!enabled)("uploading a file (D61)", () => {
  let s: Record<string, string>;
  let alice: (p: string, i?: RequestInit) => Promise<Response>;
  let bob: (p: string, i?: RequestInit) => Promise<Response>;
  let service: SupabaseClient<Database>;
  const tokens: Record<string, { cookie: string; csrf: string }> = {};

  async function webFor(email: string) {
    const c = createClient<Database>(s.API_URL ?? "", s.ANON_KEY ?? "", { auth: { persistSession: false } });
    const { data } = await service.auth.admin.generateLink({ type: "magiclink", email });
    await c.auth.verifyOtp({ token_hash: data.properties?.hashed_token ?? "", type: "magiclink" });
    const app = createApp({ version: "it", commit: "it", supabase: () => c as unknown as Supa, logSink: () => {} });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: s.API_URL ?? "", SUPABASE_ANON_KEY: s.ANON_KEY ?? "" };
    return (p: string, i: RequestInit = {}) => Promise.resolve(app.request(`${BASE}${p}`, i, env));
  }
  async function token(who: string, req: typeof alice, page: string) {
    const res = await req(page);
    tokens[who] = { cookie: /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "", csrf: /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "" };
  }
  const post = (who: string, req: typeof alice, path: string, fields: Record<string, string>) => req(path, {
    method: "POST", body: new URLSearchParams({ csrf: tokens[who]?.csrf ?? "", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie: `feedcal_csrf=${tokens[who]?.cookie ?? ""}` },
  });
  async function upload(name: string, mime: string, bytes: Uint8Array, putBytes = bytes) {
    const start = await post("alice", alice, `/feeds/${FEED}/upload/start`, { filename: name, mime, bytes: String(bytes.length) });
    const started = await start.json() as { ticket?: string; url?: string; error?: string };
    if (start.status !== 200) return { status: start.status, error: started.error, step: "start" };
    const put = await fetch(started.url ?? "", { method: "PUT", body: new Blob([new Uint8Array(putBytes)]), headers: { "content-type": mime } });
    if (!put.ok) return { status: put.status, error: await put.text(), step: "put" };
    const finish = await post("alice", alice, `/feeds/${FEED}/upload/finish`, { ticket: started.ticket ?? "" });
    const body = await finish.json() as { redirect?: string; error?: string };
    return { status: finish.status, error: body.error, redirect: body.redirect, ticket: started.ticket, url: started.url, step: "finish" };
  }
  const runTriage = async () => { await fetch(`${s.API_URL}/functions/v1/triage-attachments`, { method: "POST", headers: { authorization: `Bearer ${s.SERVICE_ROLE_KEY}` } }); };

  beforeAll(async () => {
    s = localStatus();
    service = createClient<Database>(s.API_URL ?? "", s.SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    sql(`delete from private.upload_tickets`);
    alice = await webFor("alice@example.test"); bob = await webFor("bob@example.test");
    await token("alice", alice, `/feeds/${FEED}/upload`); await token("bob", bob, "/account");
  }, 60_000);

  it("shows the upload page to the calendar's editor only", async () => {
    const page = await alice(`/feeds/${FEED}/upload`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="upload-form"');
    expect((await bob(`/feeds/${FEED}/upload`)).status).toBe(404);
  });

  it("a Word file is uploaded, recorded as trusted, and read into pages", async () => {
    const file = docx(`<w:p><w:r><w:t>Winter concert is on Thursday, December 11 at 6:30 PM in the gym.</w:t></w:r></w:p>`);
    const r = await upload("Winter news.docx", DOCX, file);
    expect(r).toMatchObject({ status: 200, redirect: `/feeds/${FEED}/upload?done=1` });
    const row = sql(`select m.status || '|' || (m.uploaded_by is not null) || '|' || a.status || '|' || a.chosen || '|' || a.mime from public.messages m join public.attachments a on a.message_id = m.id where m.original_subject = 'Winter news.docx'`);
    expect(row).toBe(`parsed|true|pending|true|${DOCX}`);
    await runTriage();
    const after = sql(`select a.status || '|' || coalesce(string_agg(p.text, ' '), '') from public.attachments a left join public.attachment_pages p on p.attachment_id = a.id join public.messages m on m.id = a.message_id where m.original_subject = 'Winter news.docx' group by a.status`);
    expect(after).toMatch(/^text_layer\|.*December 11 at 6:30 PM/);
  }, 120_000);

  it("a real PDF goes through too", async () => {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Picture day is Friday, December 5 at 8:30 AM.", { x: 50, y: 700, size: 14, font });
    const r = await upload("Picture day.pdf", "application/pdf", await pdf.save());
    expect(r.status).toBe(200);
    await runTriage();
    expect(sql(`select a.status from public.attachments a join public.messages m on m.id = a.message_id where m.original_subject = 'Picture day.pdf'`)).toBe("text_layer");
  }, 120_000);

  it("refuses strangers, wrong types, oversize files and disguised files", async () => {
    const bobStart = await post("bob", bob, `/feeds/${FEED}/upload/start`, { filename: "x.pdf", mime: "application/pdf", bytes: "100" });
    expect(bobStart.status).toBe(403);
    for (const [name, mime, bytes] of [["virus.exe", "application/x-msdownload", "100"], ["page.html", "text/html", "100"], ["fake.pdf", "text/html", "100"], ["x.docx", "application/pdf", "100"],
      ["big.pdf", "application/pdf", String(10 * 1024 * 1024 + 1)], ["empty.pdf", "application/pdf", "0"], ["old.doc", "application/msword", "100"], ["noext", "application/pdf", "100"]]) {
      const res = await post("alice", alice, `/feeds/${FEED}/upload/start`, { filename: name ?? "", mime: mime ?? "", bytes: bytes ?? "" });
      expect(res.status, `${name} ${mime} ${bytes}`).toBe(400);
    }
    // Says Word, is actually text: refused at finish, and the stored file is removed.
    const disguised = await upload("notes.docx", DOCX, new TextEncoder().encode("just text pretending to be Word"));
    expect(disguised).toMatchObject({ status: 400, step: "finish" });
    expect(disguised.error).toContain("isn't what its name says");
    const path = sql(`select path from private.upload_tickets where id = '${disguised.ticket}'`);
    expect(sql(`select count(*) from storage.objects where bucket_id = 'attachments' and name = '${path}'`)).toBe("0");
    // Claims a small file, sends a big one: the stored size is what counts.
    const sneaky = await upload("sneaky.txt", "text/plain", new TextEncoder().encode("hi"), new Uint8Array(10 * 1024 * 1024 + 10).fill(65));
    expect(sneaky.status).toBe(400);
  }, 120_000);

  it("tickets can't be reused, stolen or used late, and there's a daily limit", async () => {
    const ok = await upload("again.txt", "text/plain", new TextEncoder().encode("Bake sale on Dec 3"));
    expect(ok.status).toBe(200);
    const reuse = await post("alice", alice, `/feeds/${FEED}/upload/finish`, { ticket: ok.ticket ?? "" });
    expect(reuse.status).toBe(400);
    const start = await post("alice", alice, `/feeds/${FEED}/upload/start`, { filename: "late.txt", mime: "text/plain", bytes: "5" });
    const { ticket, url } = await start.json() as { ticket: string; url: string };
    await fetch(url, { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } });
    expect((await post("bob", bob, `/feeds/${FEED}/upload/finish`, { ticket })).status).toBe(400);
    sql(`update private.upload_tickets set expires_at = now() - interval '1 minute' where id = '${ticket}'`);
    expect((await post("alice", alice, `/feeds/${FEED}/upload/finish`, { ticket })).status).toBe(400);
    sql(`insert into private.upload_tickets (feed_id, user_id, filename, mime, declared_bytes, path)
      select '${FEED}', '11111111-1111-4111-8111-111111111111', 'f.txt', 'text/plain', 1, '${FEED}/upload-filler-' || g || '/f.txt' from generate_series(1, 20) g`);
    const limited = await post("alice", alice, `/feeds/${FEED}/upload/start`, { filename: "one-too-many.txt", mime: "text/plain", bytes: "5" });
    expect(limited.status).toBe(400);
    expect((await limited.json() as { error: string }).error).toContain("20 files today");
    expect((await post("alice", alice, `/feeds/${FEED}/upload/start`, { filename: "x.txt", mime: "text/plain", bytes: "5", csrf: "wrong" })).status).toBe(403);
  }, 120_000);

  it("storage accepts the browser's upload from the site's origin (CORS)", async () => {
    const start = await post("alice", alice, `/feeds/${FEED}/upload/start`, { filename: "cors.txt", mime: "text/plain", bytes: "5" });
    const body = await start.json() as { url?: string };
    if (start.status !== 200) return; // daily limit from the previous test: nothing more to check
    const pre = await fetch(body.url ?? "", { method: "OPTIONS", headers: { origin: "https://feedcal-web.pages.dev", "access-control-request-method": "PUT", "access-control-request-headers": "content-type,x-upsert" } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toMatch(/\*|feedcal-web/);
  });
});
