// Phase 11 end to end: the real web app, as signed-in Alice (and Bob as a stranger), against the
// local stack. Creates a feed, adds an event, reviews an item (reject → undo → edit and approve),
// changes settings, deletes with undo.
//   npm run test:integration
import { localStatus } from "./local-stack.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const BASE = "http://localhost:8788";

describe.skipIf(!enabled)("review screen, end to end", { timeout: 60_000 }, () => {
  let db: SupabaseClient<Database>;
  let alice: (path: string, form?: Record<string, string>) => Promise<Response>;
  let bob: (path: string, form?: Record<string, string>) => Promise<Response>;
  let feedId = "";
  const run = String(Date.now());

  async function session(url: string, anon: string, service: string, email: string) {
    const admin = createClient<Database>(url, service, { auth: { persistSession: false } });
    const { data } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const client = createClient<Database>(url, anon, { auth: { persistSession: false } });
    await client.auth.verifyOtp({ token_hash: data.properties?.hashed_token ?? "", type: "magiclink" });
    const app = createApp({ version: "it", commit: "it", supabase: () => client as unknown as Supa, logSink: () => {} });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: url, SUPABASE_ANON_KEY: anon };
    let cookie = "";
    let token = "";
    return async (path: string, form?: Record<string, string>) => {
      if (form && !token) {
        const page = await app.request(`${BASE}/account`, {}, env); // has forms, so a CSRF token
        cookie = /feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
        token = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      }
      return app.request(`${BASE}${path}`, form
        ? { method: "POST", body: new URLSearchParams({ csrf: token, ...form }), headers: { "content-type": "application/x-www-form-urlencoded", cookie: `feedcal_csrf=${cookie}`, origin: BASE } }
        : {}, env);
    };
  }

  beforeAll(async () => {
    const s = localStatus();
    const { API_URL: url, ANON_KEY: anon, SERVICE_ROLE_KEY: service } = s;
    if (!url || !anon || !service) throw new Error("Local Supabase isn't running");
    db = createClient<Database>(url, service, { auth: { persistSession: false } });
    // An established account (new accounts are limited to 3 feeds for 30 days; Phase 14).
    await db.from("profiles").update({ created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() } as never).eq("id", "11111111-1111-4111-8111-111111111111");
    alice = await session(url, anon, service, "alice@example.test");
    bob = await session(url, anon, service, "bob@example.test");
  });

  it("creates a feed from the dashboard", async () => {
    const res = await alice("/feeds/new", { name: `Room 12 ${run}`, category: "school", visibility: "unlisted" });
    expect(res.status).toBe(303);
    // D47: a new calendar goes next to "where do the emails come from?"
    feedId = /\/feeds\/([0-9a-f-]{36})\/setup$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
    expect(feedId).not.toBe("");
    const setup = await (await alice(`/feeds/${feedId}/setup`)).text();
    expect(setup).toContain("emails come from?");
    const dash = await (await alice("/feeds")).text();
    expect(dash).toContain(`Room 12 ${run}`);
    const home = await (await alice(`/feeds/${feedId}`)).text();
    expect(home).toContain("Nothing needs you.");
  });

  it("adds an event by hand, in the feed's time zone, with history", async () => {
    const res = await alice(`/feeds/${feedId}/events`, { title: "Class party", date: "2026-12-18", time: "13:30", location: "Room 12" });
    expect(res.status).toBe(303);
    const { data: e } = await db.from("events").select("id, starts_at, published").eq("feed_id", feedId).eq("title", "Class party").single();
    expect(e).toMatchObject({ published: true });
    expect(new Date(e?.starts_at ?? "").toISOString()).toBe("2026-12-18T21:30:00.000Z");
    const page = await (await alice(`/feeds/${feedId}/events/${e?.id}`)).text();
    expect(page).toContain("History");
    expect(page).toContain('value="13:30"');
  });

  it("reviews an item: reject, undo within 10 seconds, then edit and approve", async () => {
    const { data: m } = await db.from("messages").insert({ feed_id: feedId, status: "needs_review", clean_text: "If it rains, the walkathon moves to Sunday at 10 AM.", original_subject: "Walkathon" }).select("id").single();
    const { data: cand } = await db.from("event_candidates").insert({
      message_id: m?.id ?? "", feed_id: feedId, title: "Walkathon", starts_at: "2026-11-29T18:00:00Z", all_day: false, timezone: "America/Los_Angeles",
      change_kind: "new", confidence: 0.75, evidence_quote: "the walkathon moves to Sunday at 10 AM", source_kind: "body", state: "needs_review", outcome: "new", review_reasons: ["low_confidence"],
    }).select("id").single();
    const home = await (await alice(`/feeds/${feedId}`)).text();
    expect(home).toContain("<mark>the walkathon moves to Sunday at 10 AM</mark>");
    expect(home).toContain("Needs you");
    expect(home).toContain("Why it's waiting:");

    const reject = await alice(`/feeds/${feedId}/candidates/${cand?.id}/reject`, { reason: "wrong_date", note: "it's the 30th" });
    const undoId = /undo=([0-9a-f-]{36})/.exec(reject.headers.get("location") ?? "")?.[1] ?? "";
    expect(undoId).not.toBe("");
    expect((await db.from("event_candidates").select("state, reject_reason").eq("id", cand?.id ?? "").single()).data).toEqual({ state: "rejected", reject_reason: "wrong_date" });
    const undo = await alice(`/undo/${undoId}`, { back: `/feeds/${feedId}` });
    expect(undo.headers.get("location")).toBe(`/feeds/${feedId}?done=undone`);
    expect((await db.from("event_candidates").select("state").eq("id", cand?.id ?? "").single()).data?.state).toBe("needs_review");

    // Bob, a stranger, can't see or act on it.
    expect((await bob(`/feeds/${feedId}`)).status).toBe(404);
    await bob(`/feeds/${feedId}/candidates/${cand?.id}/approve`, {});
    expect((await db.from("event_candidates").select("state").eq("id", cand?.id ?? "").single()).data?.state).toBe("needs_review");

    await alice(`/feeds/${feedId}/candidates/${cand?.id}/approve`, { title: "Walkathon (rain date)", date: "2026-11-30", time: "10:00", location: "" });
    const { data: ev } = await db.from("events").select("title, starts_at, published").eq("feed_id", feedId).eq("title", "Walkathon (rain date)").single();
    expect(ev?.published).toBe(true);
    expect(new Date(ev?.starts_at ?? "").toISOString()).toBe("2026-11-30T18:00:00.000Z");
  });

  it("changes settings and deletes with undo", async () => {
    await alice(`/feeds/${feedId}/settings`, { name: `Room 12 ${run}`, description: "", visibility: "unlisted", timezone: "America/Denver", threshold: "0.9" });
    expect((await db.from("feeds").select("timezone, auto_publish_threshold").eq("id", feedId).single()).data).toEqual({ timezone: "America/Denver", auto_publish_threshold: 0.9 });
    const del = await alice(`/feeds/${feedId}/delete`, { confirm: "yes" });
    const undoId = /undo=([0-9a-f-]{36})/.exec(del.headers.get("location") ?? "")?.[1] ?? "";
    expect((await alice(`/feeds/${feedId}`)).status).toBe(404);
    await alice(`/undo/${undoId}`, { back: "/feeds" });
    expect((await alice(`/feeds/${feedId}`)).status).toBe(200);
    await db.from("feeds").delete().eq("id", feedId); // tidy up
  });
});
