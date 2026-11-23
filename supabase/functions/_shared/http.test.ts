// Scheduler-only functions refuse a signed-in person's token and accept the project's keys.
import { assertEquals } from "jsr:@std/assert@1";
import { carriesUser } from "./http.ts";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: unknown) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
const req = (auth?: string) => new Request("https://x.test/functions/v1/extract-events", { method: "POST", headers: auth ? { authorization: auth } : {} });

Deno.test("the project's public key (what the scheduler sends) passes", () => {
  assertEquals(carriesUser(req(`Bearer ${jwt({ role: "anon", iss: "supabase" })}`)), false);
});
Deno.test("the service key passes", () => {
  assertEquals(carriesUser(req(`Bearer ${jwt({ role: "service_role" })}`)), false);
});
Deno.test("a signed-in person's token is refused", () => {
  assertEquals(carriesUser(req(`Bearer ${jwt({ role: "authenticated", sub: "11111111-1111-4111-8111-111111111111" })}`)), true);
});
Deno.test("a token with no role, or an unreadable one, is refused", () => {
  assertEquals(carriesUser(req(`Bearer ${jwt({ sub: "x" })}`)), true);
  assertEquals(carriesUser(req("Bearer aaa.%%%.ccc")), true);
});
Deno.test("an API key that is not a JWT has no person behind it", () => {
  assertEquals(carriesUser(req("Bearer sb_publishable_abcdefghijklmnopqrstuvwxyz")), false);
  assertEquals(carriesUser(req()), false);
});
