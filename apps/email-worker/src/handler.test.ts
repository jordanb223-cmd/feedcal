import { describe, expect, it } from "vitest";
import { handleEmail, REASONS, sign, TemporaryFailure, type InboundMessage, type WorkerEnv } from "./handler.js";

const ENV: WorkerEnv = { SUPABASE_URL: "http://db.test", INGEST_HMAC_SECRET: "test-secret-that-is-at-least-32-characters" };
const TO = "feed-aliceschoolfeed23456@in.feedcal.app";
const RAW = "From: office@school.example\r\nSubject: Hi\r\n\r\nHello";

function message(to = TO, raw = RAW, rawSize = raw.length) {
  let rejected: string | null = null;
  const msg: InboundMessage = {
    from: "office@school.example",
    to,
    rawSize,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    setReject: (r) => { rejected = r; },
  };
  return { msg, rejected: () => rejected };
}

type Reply = { status?: number; body?: unknown };
function fakeNet(replies: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(replies).find((k) => url.includes(k)) ?? "";
    const r = replies[key] ?? { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const started = { body: { ok: true, ticket: "t-1", path: "feed/ticket.eml", token: "tok en" } };

describe("signing", () => {
  it("matches the vector the Edge Functions pin (supabase/functions/_shared/intake.test.ts)", async () => {
    expect(await sign("test-secret-that-is-at-least-32-characters", "1795000000", '{"to":"feed-x@in.example"}')).toBe(
      "826e65460bfe16d649364040af218630f35b62f5e4fd39a661cf870901e11b2b",
    );
  });
});

describe("handleEmail", () => {
  it("starts, uploads the raw bytes with the one-time token, commits, and logs no addresses", async () => {
    const net = fakeNet({ "ingest-start": started, "upload/sign": {}, "ingest-commit": { body: { ok: true, outcome: "queued" } } });
    const logs: string[] = [];
    const { msg, rejected } = message();
    await handleEmail(msg, ENV, { fetch: net.f, now: () => 1_795_000_000_000, sink: (l) => logs.push(l) });

    expect(rejected()).toBeNull();
    expect(net.calls.map((c) => c.url)).toEqual([
      "http://db.test/functions/v1/ingest-start",
      "http://db.test/storage/v1/object/upload/sign/inbound-raw/feed/ticket.eml?token=tok%20en",
      "http://db.test/functions/v1/ingest-commit",
    ]);
    const startCall = net.calls[0]?.init;
    const headers = startCall?.headers as Record<string, string>;
    expect(headers["x-feedcal-timestamp"]).toBe("1795000000");
    expect(headers["x-feedcal-signature"]).toBe(await sign(ENV.INGEST_HMAC_SECRET, "1795000000", String(startCall?.body)));
    expect(new TextDecoder().decode(net.calls[1]?.init.body as ArrayBuffer)).toBe(RAW);
    expect(JSON.parse(String(net.calls[2]?.init.body))).toEqual({ ticket: "t-1", path: "feed/ticket.eml" });
    const all = logs.join("\n");
    expect(all).not.toContain("school.example");
    expect(all).not.toContain("aliceschoolfeed");
    expect(all).toContain("email_accepted");
  });

  it("bounces a malformed address without calling anything", async () => {
    const net = fakeNet({});
    const { msg, rejected } = message("postmaster@in.feedcal.app");
    await handleEmail(msg, ENV, { fetch: net.f, sink: () => {} });
    expect(rejected()).toBe(REASONS.unknown_address);
    expect(net.calls).toHaveLength(0);
  });

  it("bounces over 20 MB before uploading", async () => {
    const net = fakeNet({});
    const { msg, rejected } = message(TO, RAW, 21 * 1024 * 1024);
    await handleEmail(msg, ENV, { fetch: net.f, sink: () => {} });
    expect(rejected()).toBe(REASONS.too_large);
    expect(net.calls).toHaveLength(0);
  });

  it.each(["unknown_address", "daily_limit"])("bounces politely when ingest-start says %s", async (reason) => {
    const net = fakeNet({ "ingest-start": { body: { ok: false, reject: reason } } });
    const { msg, rejected } = message();
    await handleEmail(msg, ENV, { fetch: net.f, sink: () => {} });
    expect(rejected()).toBe(REASONS[reason]);
    expect(net.calls).toHaveLength(1);
  });

  it("bounces when ingest-commit finds too many attachments", async () => {
    const net = fakeNet({ "ingest-start": started, "upload/sign": {}, "ingest-commit": { body: { ok: false, reject: "too_many_attachments" } } });
    const { msg, rejected } = message();
    await handleEmail(msg, ENV, { fetch: net.f, sink: () => {} });
    expect(rejected()).toBe(REASONS.too_many_attachments);
  });

  it("a duplicate is accepted quietly (no bounce)", async () => {
    const net = fakeNet({ "ingest-start": started, "upload/sign": {}, "ingest-commit": { body: { ok: true, outcome: "duplicate" } } });
    const { msg, rejected } = message();
    await handleEmail(msg, ENV, { fetch: net.f, sink: () => {} });
    expect(rejected()).toBeNull();
  });

  it.each([
    ["the start call fails", { "ingest-start": { status: 503 } }],
    ["the upload fails", { "ingest-start": started, "upload/sign": { status: 500 } }],
    ["the commit fails", { "ingest-start": started, "upload/sign": {}, "ingest-commit": { status: 503 } }],
  ])("throws a temporary failure (so the sender retries) when %s", async (_name, replies) => {
    const net = fakeNet(replies as Record<string, Reply>);
    const { msg, rejected } = message();
    await expect(handleEmail(msg, ENV, { fetch: net.f, sink: () => {} })).rejects.toBeInstanceOf(TemporaryFailure);
    expect(rejected()).toBeNull();
  });

  it("refuses to run without its secret", async () => {
    const { msg } = message();
    await expect(handleEmail(msg, { ...ENV, INGEST_HMAC_SECRET: "" }, { sink: () => {} })).rejects.toBeInstanceOf(TemporaryFailure);
  });
});
