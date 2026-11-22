// D60: text from emails must never make a parser slow. Each pathological input is far beyond a
// real header or body line; the old sender parser took 3.7 s on 3,000 "@"s (cubic growth).
import { assert } from "jsr:@std/assert@1";
import { parseSender, unwrapForwards } from "./forward.ts";
import { parseMessage } from "./parse.ts";
import { extractAddress } from "../intake.ts";

const UNITS = ["@", "a@", "@.", "a@b.", "<", "<@", "<a@", ">", "\"", "(", "a", ".", "-", " ", "=?utf-8?q?", "日", " "];
const LIMIT_MS = 300;

Deno.test("address parsers stay fast on any 100,000-character line", () => {
  for (const fn of [parseSender, extractAddress] as ((s: string) => unknown)[]) for (const u of UNITS) {
    const line = u.repeat(Math.ceil(100_000 / u.length));
    const t0 = performance.now(); fn(line); const ms = performance.now() - t0;
    assert(ms < LIMIT_MS, `${fn.name} took ${ms.toFixed(0)} ms on ${JSON.stringify(u)} x 100k`);
  }
});

Deno.test("a whole crafted email parses quickly", async () => {
  const email = (fwdFrom: string) => ["From: Parent <parent@home.example>", "To: f@in.calantern.test", "Subject: Fwd: Picture day", "Message-ID: <x@home.example>",
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "See below.", "", "---------- Forwarded message ---------", `From: ${fwdFrom}`,
    "Date: Thu, 20 Nov 2026 09:00:00 -0800", "Subject: Picture day", "To: parents@school.example", "", "Picture day is Fri, Dec 5."].join("\r\n");
  for (const from of ["@".repeat(50_000), "a@".repeat(25_000), "<".repeat(50_000), "<@".repeat(25_000), `Office <${"x".repeat(50_000)}@school.example>`]) {
    const t0 = performance.now(); await parseMessage(email(from), { receivedAt: "2026-11-21T18:00:00Z" }); const ms = performance.now() - t0;
    assert(ms < 1000, `parseMessage took ${ms.toFixed(0)} ms`);
  }
});

Deno.test("still reads ordinary senders the same way", () => {
  assert(JSON.stringify(parseSender("Office <office@school.example>")) === JSON.stringify({ address: "office@school.example", name: "Office" }));
  assert(JSON.stringify(parseSender('"Ms. Lee" <LEE@School.Example>')) === JSON.stringify({ address: "lee@school.example", name: "Ms. Lee" }));
  assert(JSON.stringify(parseSender("coach@league.example (Coach)")) === JSON.stringify({ address: "coach@league.example", name: "Coach" }));
  assert(parseSender("no address here") === null);
  assert(extractAddress("Office <office@school.example>") === "office@school.example");
  assert(extractAddress("x@y.example") === "x@y.example");
  assert(unwrapForwards("hello", null).depth === 0);
});
