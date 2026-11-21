import { assert, assertEquals } from "jsr:@std/assert@1";
import { BmcEvent, signatureValid, supporterOf } from "./bmc.ts";

const SECRET = "whsec_test_123456";
// A recorded-shape payload (outer fields from BMC's help centre; data fields as BMC test events send them: UNVERIFIED).
const BODY = JSON.stringify({ event_id: 1234, type: "donation.created", live_mode: true, created: 1719825600, attempt: 1,
  data: { supporter_name: "Jamie", supporter_email: "Jamie@Example.test", amount: 5, currency: "usd", support_note: "Thanks!" } });

async function sign(body: string, secret = SECRET, encoding: "hex" | "base64" = "hex") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return encoding === "hex" ? Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("") : btoa(String.fromCharCode(...mac));
}

Deno.test("a correctly signed webhook is accepted (hex or base64)", async () => {
  assert(await signatureValid(SECRET, BODY, await sign(BODY)));
  assert(await signatureValid(SECRET, BODY, (await sign(BODY)).toUpperCase()));
  assert(await signatureValid(SECRET, BODY, await sign(BODY, SECRET, "base64")));
});

Deno.test("a forged or altered webhook is rejected", async () => {
  assert(!(await signatureValid(SECRET, BODY, await sign(BODY, "wrong-secret"))), "wrong secret");
  assert(!(await signatureValid(SECRET, BODY.replace('"amount":5', '"amount":500'), await sign(BODY))), "body changed");
  assert(!(await signatureValid(SECRET, BODY, null)), "no header");
  assert(!(await signatureValid(undefined, BODY, await sign(BODY))), "no secret configured");
});

Deno.test("payload parsing: outer shape, then the supporter, defensively", () => {
  const e = BmcEvent.parse(JSON.parse(BODY));
  assertEquals([e.event_id, e.type, e.live_mode], [1234, "donation.created", true]);
  assertEquals(supporterOf(e.data), { email: "Jamie@Example.test", name: "Jamie", amountCents: 500, currency: "USD" });
  assertEquals(supporterOf({ supporter: { email: "a@b.test", name: "A" }, total_amount: "3.50" }), { email: "a@b.test", name: "A", amountCents: 350, currency: null });
  assertEquals(supporterOf({}), { email: null, name: null, amountCents: null, currency: null });
  assert(!BmcEvent.safeParse({ type: "x", live_mode: true }).success, "event_id is required");
});
