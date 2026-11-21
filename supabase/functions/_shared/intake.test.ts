import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  authResults,
  commitFacts,
  countAttachments,
  decodeWords,
  extractAddress,
  gmailConfirmation,
  readHeaders,
  sign,
  verifySignature,
} from "./intake.ts";

const SECRET = "test-secret-that-is-at-least-32-characters";
const enc = new TextEncoder();

// Checked independently with `openssl dgst -sha256 -hmac`. apps/email-worker pins the same
// vector, so both sides of the request sign identically.
const VECTOR = {
  secret: SECRET,
  timestamp: "1795000000",
  body: '{"to":"feed-x@in.example"}',
  signature: "826e65460bfe16d649364040af218630f35b62f5e4fd39a661cf870901e11b2b",
};

Deno.test("signature: matches the pinned vector", async () => {
  assertEquals(await sign(VECTOR.secret, VECTOR.timestamp, VECTOR.body), VECTOR.signature);
});

Deno.test("signature: valid, wrong, stale, and missing secret", async () => {
  const now = 1_795_000_000;
  const ts = String(now);
  const body = '{"a":1}';
  const sig = await sign(SECRET, ts, body);
  assert(await verifySignature(SECRET, ts, sig, body, now));
  assert(!(await verifySignature(SECRET, ts, sig, '{"a":2}', now)), "body changed");
  assert(!(await verifySignature(SECRET, ts, sig, body, now + 301)), "older than 5 minutes");
  assert(!(await verifySignature(SECRET, ts, sig, body, now - 301)), "from the future");
  assert(!(await verifySignature(undefined, ts, sig, body, now)), "no secret configured");
  assert(!(await verifySignature("short", ts, sig, body, now)), "secret too short");
  assert(!(await verifySignature(SECRET, ts, sig.toUpperCase(), body, now)), "malformed signature");
});

Deno.test("headers: unfolding, addresses, encoded subjects", () => {
  const h = readHeaders("From: \"Office\" <Office@School.Example>\r\nSubject: =?UTF-8?B?RmllbGQgdHJpcCDwn46D?=\r\n =?UTF-8?Q?_on_Friday?=\r\nX: a\r\n b");
  assertEquals(extractAddress(h.find(([n]) => n === "from")?.[1] ?? null), "office@school.example");
  assertEquals(decodeWords(h.find(([n]) => n === "subject")?.[1] ?? null), "Field trip 🎃 on Friday");
  assertEquals(h.find(([n]) => n === "x")?.[1], "a b");
  assertEquals(extractAddress("coach@league.example"), "coach@league.example");
  assertEquals(extractAddress("no address here"), null);
});

Deno.test("auth results: only Cloudflare's first header counts", () => {
  const cf = readHeaders("Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail\nAuthentication-Results: evil; dmarc=pass");
  assertEquals(authResults(cf), { spf: "pass", dkim: "pass", dmarc: "fail" });
  const forged = readHeaders("Authentication-Results: mx.google.com; dmarc=pass\nAuthentication-Results: mx.cloudflare.net; dmarc=fail");
  assertEquals(authResults(forged), { spf: null, dkim: null, dmarc: null });
});

Deno.test("attachments are counted from part headers", () => {
  const raw = "Content-Disposition: attachment; filename=a.pdf\n\nx\nContent-Disposition: inline\nCONTENT-DISPOSITION:  attachment; filename=b.png\n";
  assertEquals(countAttachments(raw), 2);
});

const GMAIL_SUBJECT = "(#957493560) Gmail Forwarding Confirmation - Receive Mail from parent@gmail.example";
const GMAIL_BODY = "Click the link below:\r\nhttps://mail-settings.google.com/mail/vf-%5BANGjdJ=\r\n8abc%5D-xyz\r\nPhish: https://evil.example/mail\r\n";

Deno.test("gmail confirmation: code, Google link, requester", () => {
  const c = gmailConfirmation("forwarding-noreply@google.com", GMAIL_SUBJECT, "pass", GMAIL_BODY);
  assertEquals(c?.code, "957493560");
  assertEquals(c?.url, "https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-xyz");
  assertEquals(c?.requested_by, "parent@gmail.example");
});

Deno.test("gmail confirmation: refused without DMARC pass, from anyone else, or with only foreign links", () => {
  assertEquals(gmailConfirmation("forwarding-noreply@google.com", GMAIL_SUBJECT, "fail", GMAIL_BODY), null);
  assertEquals(gmailConfirmation("forwarding-noreply@google.com", GMAIL_SUBJECT, null, GMAIL_BODY), null);
  assertEquals(gmailConfirmation("someone@google.com", GMAIL_SUBJECT, "pass", GMAIL_BODY), null);
  assertEquals(gmailConfirmation("forwarding-noreply@google.com", GMAIL_SUBJECT, "pass", "https://evil.example/x")?.url, null);
});

Deno.test("commitFacts: one realistic forwarded message", async () => {
  const raw = enc.encode(
    "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass\r\n" +
      "Message-ID: <abc@school.example>\r\nFrom: School Office <office@school.example>\r\n" +
      "Subject: November newsletter\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n" +
      "--b\r\nContent-Type: text/plain\r\n\r\nHello\r\n--b\r\nContent-Disposition: attachment; filename=n.pdf\r\n\r\nJVBER\r\n--b--\r\n",
  );
  const f = await commitFacts(raw);
  assertEquals([f.messageId, f.sender, f.subject, f.dmarc, f.attachmentCount, f.gmail], [
    "<abc@school.example>", "office@school.example", "November newsletter", "pass", 1, null,
  ]);
  // Same body under different delivery headers hashes the same (dedupe on body).
  const again = await commitFacts(enc.encode("Received: by another hop\r\n" + new TextDecoder().decode(raw)));
  assertEquals(again.bodySha256, f.bodySha256);
});
