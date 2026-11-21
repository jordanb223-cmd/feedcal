// Phase 7 end to end on the local stack: real fixture emails go through the Worker code,
// ingest functions, queue, and the process-messages Edge Function; then we read what was stored.
//   npm run test:integration
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { handleEmail, type InboundMessage } from "../../apps/email-worker/src/handler.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const ALICE_FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const TO = "feed-aliceschoolfeed23456@in.feedcal.test";
const CF = "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass\r\n";
const FIXTURES = new URL("../../supabase/functions/_shared/parse/fixtures/", import.meta.url);

function stack() {
  const s = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
  const secret = /^INGEST_HMAC_SECRET=(.+)$/m.exec(readFileSync(new URL("../../supabase/functions/.env", import.meta.url), "utf8"))?.[1]?.trim() ?? "";
  if (!s.API_URL || !s.SERVICE_ROLE_KEY || !secret) throw new Error("Local stack or supabase/functions/.env missing");
  return { url: s.API_URL, service: s.SERVICE_ROLE_KEY, secret };
}

/** A fixture with a unique Message-ID (so reruns aren't duplicates) and Cloudflare's header. */
function fixture(name: string, tag: string): { raw: string; messageId: string } {
  const messageId = `<${name}-${tag}@it.example.test>`;
  const raw = readFileSync(new URL(`${name}.eml`, FIXTURES), "latin1").replace(/^Message-ID: <[^>]+>/m, `Message-ID: ${messageId}`);
  // Body dedupe (sha256 below the headers) would treat a rerun as a duplicate forward, so each
  // run adds a unique MIME epilogue: text after the last boundary, which readers ignore.
  return { raw: `${CF}${raw}\r\nrun ${tag}\r\n`, messageId };
}

// The first call downloads the parser libraries into the Edge runtime (cold start).
describe.skipIf(!enabled)("email parsing, end to end on the local stack", { timeout: 60_000 }, () => {
  let s: ReturnType<typeof stack>;
  let db: SupabaseClient<Database>;
  const tag = String(Date.now());

  const deliver = async (raw: string) => {
    let rejected: string | null = null;
    const bytes = Buffer.from(raw, "latin1");
    const msg: InboundMessage = {
      from: "bounce@example.test", to: TO, rawSize: bytes.length,
      raw: new Response(bytes).body as ReadableStream<Uint8Array>,
      setReject: (r) => { rejected = r; },
    };
    await handleEmail(msg, { SUPABASE_URL: s.url, INGEST_HMAC_SECRET: s.secret }, { sink: () => {} });
    return rejected;
  };

  const runConsumer = async () => {
    const res = await fetch(`${s.url}/functions/v1/process-messages`, { method: "POST", headers: { authorization: `Bearer ${s.service}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, number>;
  };

  beforeAll(async () => {
    s = stack();
    db = createClient<Database>(s.url, s.service, { auth: { persistSession: false } });
    // Trust the fixture senders on Alice's feed, as the owner would after one "Yes".
    for (const sender of ["parent@home.example.test", "office@maplegrove.example.test"]) {
      // Not an upsert: the unique index is on lower(sender_email), which upsert can't target.
      const { error: insertError } = await db.from("sources").insert({ feed_id: ALICE_FEED, sender_email: sender, sender_domain: sender.split("@")[1] ?? "" });
      if (insertError && insertError.code !== "23505") throw new Error(`insert source: ${insertError.message}`);
      const { data, error } = await db.from("sources").update({ trusted: true, blocked: false }).eq("feed_id", ALICE_FEED).eq("sender_email", sender).select("id");
      if (error || data?.length !== 1) throw new Error(`trust source ${sender}: ${error?.message ?? data?.length}`);
    }
  });

  it("a forwarded email with an attached original is parsed, and its PDF stored privately", async () => {
    const f = fixture("12-forward-as-attachment", tag);
    expect(await deliver(f.raw)).toBeNull();
    // The stored result is the evidence; the call's own counts can include other tests' emails.
    await runConsumer();

    const { data: m } = await db.from("messages")
      .select("id, status, original_sender, original_subject, clean_text, reference_date, reference_date_source, parse_details")
      .eq("message_id_header", f.messageId).single();
    expect(m).toMatchObject({
      status: "parsed",
      original_sender: "patel@maplegrove.example.test",
      original_subject: "Field trip permission",
      reference_date_source: "date_header",
    });
    expect(new Date(m?.reference_date ?? "").toISOString()).toBe("2026-11-17T17:14:00.000Z");
    expect(m?.clean_text).toContain("Bus leaves at 8:45 AM");
    expect((m?.parse_details as { forwardNotes: string[] }).forwardNotes).toEqual(["FYI"]);

    const { data: atts } = await db.from("attachments").select("filename, mime, status, storage_path").eq("message_id", m?.id ?? "");
    expect(atts).toHaveLength(1);
    expect(atts?.[0]).toMatchObject({ filename: "permission-slip.pdf", mime: "application/pdf", status: "pending" });
    const file = await db.storage.from("attachments").download(atts?.[0]?.storage_path ?? "missing");
    expect(file.data?.size).toBe(60_000);
  });

  it("a newsletter keeps its table and drops its logos", async () => {
    const f = fixture("01-school-newsletter-html", tag);
    expect(await deliver(f.raw)).toBeNull();
    await runConsumer();
    const { data: m } = await db.from("messages").select("id, status, clean_text, parse_details").eq("message_id_header", f.messageId).single();
    expect(m?.status).toBe("parsed");
    expect(m?.clean_text).toContain("Nov 21 | Picture day | 8:30 AM");
    const { count } = await db.from("attachments").select("id", { count: "exact", head: true }).eq("message_id", m?.id ?? "");
    expect(count).toBe(0);
    expect((m?.parse_details as { discarded: { filename: string }[] }).discarded.map((d) => d.filename).sort()).toEqual(["facebook.png", "maple-logo.png"]);
  });

  it("an empty queue is a no-op", async () => {
    const counts = await runConsumer();
    expect(counts).toMatchObject({ parsed: 0, failed: 0 });
  });
});
