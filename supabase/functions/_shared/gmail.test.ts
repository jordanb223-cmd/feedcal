import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { accessToken, parseFrom, ReconnectError, runCheck, searchExamples, senderQuery, type CheckDeps } from "./gmail.ts";

// A fake Google: records every request, so tests can prove what was (and wasn't) searched.
function fakeGoogle(opts: { tokenError?: string; list?: Record<string, string[]>; meta?: Record<string, { from: string; subject: string; date: number }>; raw?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (url.hostname === "oauth2.googleapis.com") return opts.tokenError ? json({ error: opts.tokenError }, 400) : json({ access_token: "at" });
    if (url.pathname.endsWith("/messages")) return json({ messages: (opts.list?.[url.searchParams.get("q") ?? ""] ?? []).map((id) => ({ id })) });
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (url.searchParams.get("format") === "metadata") {
      const m = opts.meta?.[id];
      return m ? json({ id, internalDate: String(m.date), payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }] } }) : json({}, 404);
    }
    const raw = opts.raw?.[id];
    return raw ? json({ raw: btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }) : json({}, 404);
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("parseFrom reads only real addresses", () => {
  assertEquals(parseFrom('"Room F" <Office@School.example>'), { email: "office@school.example", name: "Room F" });
  assertEquals(parseFrom("office@school.example"), { email: "office@school.example", name: "" });
  assertEquals(parseFrom("Room F <not-an-address>"), null);
});

Deno.test("example search: the owner's words, last 30 days, max 10, metadata only", async () => {
  const q = "Room F newer_than:30d -in:chats";
  const { f, calls } = fakeGoogle({ list: { [q]: ["m1", "m2"] }, meta: {
    m1: { from: "Room F <office@school.example>", subject: "November schedule", date: Date.UTC(2026, 10, 14) },
    m2: { from: "Coach <coach@team.example>", subject: "Practice", date: Date.UTC(2026, 10, 12) } } });
  const out = await searchExamples(f, "at", "Room F");
  assertEquals(out.map((c) => [c.id, c.from_email, c.subject]), [["m1", "office@school.example", "November schedule"], ["m2", "coach@team.example", "Practice"]]);
  assert(calls.some((c) => c.includes("maxResults=10")), "at most 10 results");
  assert(calls.every((c) => !c.includes("format=raw")), "no message bodies are read while searching");
});

Deno.test("the scheduled query is only the confirmed sender, after the last check", () => {
  assertEquals(senderQuery("office@school.example", new Date("2026-11-14T16:00:00Z")), "from:office@school.example after:1794672000");
  let threw = false;
  try { senderQuery("x OR in:anywhere", new Date()); } catch { threw = true; }
  assert(threw, "anything that isn't a plain address is refused (no extra search terms)");
});

Deno.test("a check reads the example first, then new mail from the sender, skipping seen ones", async () => {
  const after = new Date("2026-11-14T16:00:00Z");
  const q = senderQuery("office@school.example", after);
  const { f, calls } = fakeGoogle({ list: { [q]: ["new1", "old1"] }, raw: { ex1: "Subject: Example\r\n\r\nPicture day Fri", new1: "Subject: New\r\n\r\nConcert", old1: "x" } });
  const ingested: string[] = [];
  const recorded: string[] = [];
  const d: CheckDeps = {
    fetch: f, clientId: "c", clientSecret: "s", now: () => new Date("2026-11-21T19:00:00Z"),
    seen: async (ids) => ids.filter((i) => i === "old1"),
    ingest: async (raw) => { ingested.push(new TextDecoder().decode(raw)); return { outcome: "queued", messageId: crypto.randomUUID() }; },
    record: async (id) => { recorded.push(id); },
  };
  const r = await runCheck({ refreshToken: "rt", sender: "office@school.example", exampleId: "ex1", lastCheckedAt: after }, d);
  assertEquals(recorded, ["ex1", "new1"], "example first, then new mail; the seen one is skipped");
  assert(ingested[0]!.includes("Picture day"), "the raw email goes to the normal intake");
  assertEquals(r.checkedAt.toISOString(), "2026-11-21T19:00:00.000Z");
  const searches = calls.filter((c) => c.includes("/messages?"));
  assertEquals(searches.length, 1, "one search per check");
  assert(searches[0]!.includes(encodeURIComponent("from:office@school.example")), "and it is only for that sender");
});

Deno.test("Google refusing the token means 'reconnect', not a crash", async () => {
  const { f } = fakeGoogle({ tokenError: "invalid_grant" });
  await assertRejects(() => accessToken(f, "c", "s", "rt"), ReconnectError);
});
