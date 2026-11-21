// Phase 6 end to end on the local stack: the real Worker code, the real Edge Functions, Storage,
// SQL and the pgmq queue. Only Cloudflare itself is simulated (we call handleEmail directly and
// add the Authentication-Results header Cloudflare would add).
//   npm run test:integration   (needs supabase/functions/.env with INGEST_HMAC_SECRET; see SETUP)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@feedcal/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { handleEmail, REASONS, type InboundMessage } from "../../apps/email-worker/src/handler.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const ALICE_FEED = "aaaaaaaa-0000-4000-8000-000000000001";
const TO = "feed-aliceschoolfeed23456@in.feedcal.test";
const CF = "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass\r\n";

function localStack() {
  const s = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
  const env = readFileSync(new URL("../../supabase/functions/.env", import.meta.url), "utf8");
  const secret = /^INGEST_HMAC_SECRET=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
  if (!s.API_URL || !s.SERVICE_ROLE_KEY || !secret) throw new Error("Local stack or supabase/functions/.env missing");
  return { url: s.API_URL, service: s.SERVICE_ROLE_KEY, secret };
}

function email(raw: string, to = TO) {
  let rejected: string | null = null;
  const msg: InboundMessage = {
    from: "bounce@example.test",
    to,
    rawSize: new TextEncoder().encode(raw).length,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    setReject: (r) => { rejected = r; },
  };
  return { msg, rejected: () => rejected };
}

const newsletter = (messageId: string, body = "Field trip on Friday at 9.") =>
  `${CF}Message-ID: <${messageId}>\r\nFrom: School Office <office@school.example.test>\r\nSubject: Newsletter\r\n\r\n${body}\r\n`;

describe.skipIf(!enabled)("email intake, end to end on the local stack", () => {
  let stack: ReturnType<typeof localStack>;
  let db: SupabaseClient<Database>;
  const deliver = (raw: string, to?: string) => {
    const e = email(raw, to);
    return handleEmail(e.msg, { SUPABASE_URL: stack.url, INGEST_HMAC_SECRET: stack.secret }, { sink: () => {} }).then(() => e.rejected());
  };
  beforeAll(() => {
    stack = localStack();
    db = createClient<Database>(stack.url, stack.service, { auth: { persistSession: false } });
  });

  it("a trusted sender's email is stored privately and queued", async () => {
    const id = `trusted-${Date.now()}@school.example.test`;
    expect(await deliver(newsletter(id))).toBeNull();
    const { data: m } = await db.from("messages").select("id, status, quarantine_reason, storage_path, auth_dmarc, sender").eq("message_id_header", `<${id}>`).single();
    expect(m).toMatchObject({ status: "received", quarantine_reason: null, auth_dmarc: "pass", sender: "office@school.example.test" });
    const file = await db.storage.from("inbound-raw").download(m?.storage_path ?? "missing");
    expect(await file.data?.text()).toContain("Field trip on Friday");
  });

  it("forwarding the same email again is ignored, and its copy is deleted", async () => {
    const id = `dup-${Date.now()}@school.example.test`;
    await deliver(newsletter(id, "Unique body for the duplicate test."));
    expect(await deliver(newsletter(id, "Unique body for the duplicate test."))).toBeNull();
    const { count } = await db.from("messages").select("id", { count: "exact", head: true }).eq("message_id_header", `<${id}>`);
    expect(count).toBe(1);
    const { data: files } = await db.storage.from("inbound-raw").list(ALICE_FEED, { limit: 1000 });
    const { count: messageFiles } = await db.from("messages").select("id", { count: "exact", head: true }).eq("feed_id", ALICE_FEED).not("storage_path", "is", null);
    expect(files?.length).toBe(messageFiles); // no orphan copy left behind
  });

  it("a new sender waits for the owner", async () => {
    const raw = `${CF}Message-ID: <pta-${Date.now()}@pta.example.test>\r\nFrom: chair@pta.example.test\r\nSubject: Bake sale\r\n\r\nSaturday ${Date.now()}\r\n`;
    expect(await deliver(raw)).toBeNull();
    const { data } = await db.from("messages").select("quarantine_reason").eq("sender", "chair@pta.example.test").limit(1).single();
    expect(data).toMatchObject({ quarantine_reason: "new_sender" });
  });

  it("Gmail's forwarding confirmation code is captured, not stored as mail", async () => {
    const raw = `${CF}Message-ID: <fwd-${Date.now()}@google.com>\r\nFrom: Gmail Team <forwarding-noreply@google.com>\r\n` +
      `Subject: (#957493560) Gmail Forwarding Confirmation - Receive Mail from parent@gmail.example\r\n\r\n` +
      `To allow forwarding, click:\r\nhttps://mail-settings.google.com/mail/vf-abc123\r\n`;
    expect(await deliver(raw)).toBeNull();
    const { data } = await db.from("forwarding_confirmations").select("code, confirm_url").eq("feed_id", ALICE_FEED).order("received_at", { ascending: false }).limit(1).single();
    expect(data).toEqual({ code: "957493560", confirm_url: "https://mail-settings.google.com/mail/vf-abc123" });
  });

  it("an unknown address bounces with a plain reason", async () => {
    expect(await deliver(newsletter("x@y"), "feed-zzzzzzzzzzzzzzzzzzzz@in.feedcal.test")).toBe(REASONS.unknown_address);
  });

  it("the storage-trash function deletes queued files", async () => {
    const res = await fetch(`${stack.url}/functions/v1/storage-trash`, { method: "POST", headers: { authorization: `Bearer ${stack.service}` } });
    expect(res.status).toBe(200);
    const { data } = await db.rpc("claim_storage_trash", { p_limit: 10 });
    expect(data).toEqual([]);
  });
});
