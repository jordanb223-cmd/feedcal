// Phase 8 end to end on the local stack: email → parse → triage, the owner's "this one" as a real
// signed-in user, and the next email from that sender going straight to the matching file.
//   npm run test:integration
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { handleEmail, type InboundMessage } from "../../apps/email-worker/src/handler.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const ALICE_FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const TO = "feed-aliceschoolfeed23456@in.feedcal.test";
const SENDER = "news@sutterville.example.test";

function stack() {
  const s = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
  const secret = /^INGEST_HMAC_SECRET=(.+)$/m.exec(readFileSync(new URL("../../supabase/functions/.env", import.meta.url), "utf8"))?.[1]?.trim() ?? "";
  if (!s.API_URL || !s.SERVICE_ROLE_KEY || !s.ANON_KEY || !secret) throw new Error("Local stack or supabase/functions/.env missing");
  return { url: s.API_URL, service: s.SERVICE_ROLE_KEY, anon: s.ANON_KEY, secret };
}

async function pdf(pages: string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((l, i) => page.drawText(l, { x: 40, y: 740 - i * 16, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

const PROSE = ["Thank you to every family who helped with the reading program this term.", "Please label jackets and lunch boxes."];
const DATES = ["Sat Nov 21 | Picture day | 8:30 AM", "Wed Nov 25 | Early dismissal | 12:30 PM", "Fri Dec 11 | Winter concert | 6:30 PM"];

function email(tag: string, files: { name: string; type: string; data: Buffer }[]): string {
  const b = `b-${tag}`;
  const parts = files.map((f) => [`--${b}`, `Content-Type: ${f.type}; name="${f.name}"`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${f.name}"`, "", f.data.toString("base64").replace(/.{76}/g, "$&\r\n")].join("\r\n"));
  return ["Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass", `From: Sutterville News <${SENDER}>`, `To: ${TO}`,
    `Subject: This week ${tag}`, "Date: Fri, 21 Nov 2026 08:00:00 -0800", `Message-ID: <${tag}@it.example.test>`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, "Content-Type: text/plain; charset=utf-8", "", `Attached. (${tag})`,
    ...parts, `--${b}--`, ""].join("\r\n");
}

describe.skipIf(!enabled)("attachment triage, end to end on the local stack", { timeout: 90_000 }, () => {
  let s: ReturnType<typeof stack>;
  let db: SupabaseClient<Database>;
  let alice: SupabaseClient<Database>;
  const run = String(Date.now());

  const deliver = async (raw: string) => {
    const bytes = Buffer.from(raw, "latin1");
    let rejected: string | null = null;
    const msg: InboundMessage = { from: "bounce@example.test", to: TO, rawSize: bytes.length, raw: new Response(bytes).body as ReadableStream<Uint8Array>, setReject: (r) => { rejected = r; } };
    await handleEmail(msg, { SUPABASE_URL: s.url, INGEST_HMAC_SECRET: s.secret }, { sink: () => {} });
    expect(rejected).toBeNull();
  };
  const call = async (fn: string) => {
    const res = await fetch(`${s.url}/functions/v1/${fn}`, { method: "POST", headers: { authorization: `Bearer ${s.service}` } });
    expect(res.status).toBe(200);
  };
  const pipeline = async () => { await call("process-messages"); await call("triage-attachments"); };
  const attachmentsOf = async (tag: string) => {
    const { data: m } = await db.from("messages").select("id, pages_for_ai").eq("message_id_header", `<${tag}@it.example.test>`).single();
    const { data } = await db.from("attachments").select("id, filename, status, chosen, triage").eq("message_id", m?.id ?? "").order("filename");
    return { message: m, atts: (data ?? []).map((a) => ({ ...a, reason: (a.triage as { reason?: string } | null)?.reason })) };
  };

  beforeAll(async () => {
    s = stack();
    db = createClient<Database>(s.url, s.service, { auth: { persistSession: false } });
    const { error: insertError } = await db.from("sources").insert({ feed_id: ALICE_FEED, sender_email: SENDER, sender_domain: "sutterville.example.test" });
    if (insertError && insertError.code !== "23505") throw new Error(insertError.message);
    // A fresh rule each run, so "this one" is learned here and not left over from a previous run.
    const { error } = await db.from("sources").update({ trusted: true, blocked: false, attachment_rule: null }).eq("feed_id", ALICE_FEED).eq("sender_email", SENDER);
    if (error) throw new Error(error.message);
    // Alice, signed in for real, makes the owner's choice through RLS.
    const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: "alice@example.test" });
    alice = createClient<Database>(s.url, s.anon, { auth: { persistSession: false } });
    await alice.auth.verifyOtp({ token_hash: link.properties?.hashed_token ?? "", type: "magiclink" });
  });

  it("first email: the newsletter's date page is read; the weekly file has no dates and is skipped", async () => {
    await deliver(email(`w47-${run}`, [
      { name: "newsletter.pdf", type: "application/pdf", data: await pdf([PROSE, PROSE, PROSE, PROSE, DATES, PROSE]) },
      { name: "Schedule-Week-47.pdf", type: "application/pdf", data: await pdf([["Week 47", `See the coach's notes for details. ${run}`]]) },
    ]));
    await pipeline();
    const { message, atts } = await attachmentsOf(`w47-${run}`);
    expect(atts.map((a) => [a.filename, a.status, a.reason])).toEqual([
      ["newsletter.pdf", "text_layer", "text_layer"],
      ["Schedule-Week-47.pdf", "skipped", "no_schedule_found"],
    ]);
    expect((atts[0]?.triage as { keptPages: number[] }).keptPages).toEqual([4]);
    expect(message?.pages_for_ai).toBe(1);
    const { data: page } = await db.from("attachment_pages").select("page_index, text, text_source").eq("attachment_id", atts[0]?.id ?? "").single();
    expect(page).toMatchObject({ page_index: 4, text_source: "text_layer" });
    expect(page?.text).toContain("Picture day");
  });

  it("the owner taps 'this one' on the weekly file: it's re-read, and the rule is learned", async () => {
    const { atts } = await attachmentsOf(`w47-${run}`);
    const weekly = atts.find((a) => a.filename === "Schedule-Week-47.pdf");
    const { error } = await alice.rpc("choose_attachment", { p_attachment_id: weekly?.id ?? "" });
    expect(error).toBeNull();
    await call("triage-attachments");
    const after = await attachmentsOf(`w47-${run}`);
    expect(after.atts.map((a) => [a.filename, a.status, a.chosen])).toEqual([
      ["newsletter.pdf", "skipped", false],
      ["Schedule-Week-47.pdf", "text_layer", true],
    ]);
  });

  it("next email from that sender goes straight to the right file", async () => {
    await deliver(email(`w48-${run}`, [
      { name: "newsletter.pdf", type: "application/pdf", data: await pdf([PROSE, DATES, [`Issue ${run}`]]) },
      { name: "Schedule-Week-48.pdf", type: "application/pdf", data: await pdf([["Week 48", `Notes from the coach. ${run}`]]) },
    ]));
    await pipeline();
    const { atts } = await attachmentsOf(`w48-${run}`);
    expect(atts.map((a) => [a.filename, a.status, a.reason])).toEqual([
      ["newsletter.pdf", "skipped", "rule_other"],
      ["Schedule-Week-48.pdf", "text_layer", "text_layer"],
    ]);
  });

  it("Phase 9: triaged emails reach extraction, and wait there without an API key", async () => {
    await call("extract-events");
    const { data } = await db.from("messages").select("status, extraction").eq("message_id_header", `<w48-${run}@it.example.test>`).single();
    expect(data?.status).toBe("parsed");
    expect(data?.extraction).toMatchObject({ state: "waiting", reason: "no_api_key" });
  });

  it("a photo waits for vision when no API key is configured (free tier)", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x06, 0x40, 0x04, 0xb0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(40_000, 7), Buffer.from(run), Buffer.from([0xff, 0xd9])]);
    await deliver(email(`photo-${run}`, [{ name: "flyer.jpg", type: "image/jpeg", data: jpeg }]));
    await pipeline();
    const { atts } = await attachmentsOf(`photo-${run}`);
    expect(atts.map((a) => [a.status, a.reason])).toEqual([["pending", "needs_vision_not_configured"]]);
  });
});
