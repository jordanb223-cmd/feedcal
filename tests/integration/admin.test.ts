// Phase 14 "passes when", end to end on the local stack: a report hides a feed in one admin click,
// with an audit record. The admin really enrols a TOTP factor (local Supabase Auth) and passes the
// second step; the TOTP code is computed here from the enrolment secret (RFC 6238).
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const BASE = "http://localhost:8788";
const ALICE = "11111111-1111-4111-8111-111111111111";

function totp(base32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = (h[h.length - 1] ?? 0) & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe.skipIf(!enabled)("moderation, end to end: report → one admin click (with a real second factor)", { timeout: 60_000 }, () => {
  let db: SupabaseClient<Database>;
  let alice: SupabaseClient<Database>;
  let asAlice: (path: string, init?: RequestInit) => Promise<Response>;
  let asStranger: (path: string, init?: RequestInit) => Promise<Response>;
  const slug = `spam-${Date.now()}`;
  let feedId = "";

  beforeAll(async () => {
    const s = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
    const url = s.API_URL ?? "";
    db = createClient<Database>(url, s.SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    // Start clean: no leftover factors for Alice; make her an admin.
    const { data: factors } = await db.auth.admin.mfa.listFactors({ userId: ALICE });
    for (const f of factors?.factors ?? []) await db.auth.admin.mfa.deleteFactor({ userId: ALICE, id: f.id });
    await db.from("admins").upsert({ user_id: ALICE } as never);
    // A public spam feed by Bob (created by the operator, so new-account rules don't apply here).
    const { data: feed } = await db.from("feeds").insert({ owner_id: "22222222-2222-4222-8222-222222222222", name: "Cheap pills", slug, visibility: "public" } as never).select("id").single();
    feedId = (feed as { id: string }).id;
    await db.from("events").insert({ feed_id: feedId, title: "Sale", starts_at: new Date(Date.now() + 86_400_000).toISOString(), published: true } as never);

    const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: "alice@example.test" });
    alice = createClient<Database>(url, s.ANON_KEY ?? "", { auth: { persistSession: false } });
    await alice.auth.verifyOtp({ token_hash: link.properties?.hashed_token ?? "", type: "magiclink" });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: url, SUPABASE_ANON_KEY: s.ANON_KEY ?? "" };
    const aliceApp = createApp({ version: "it", commit: "it", supabase: () => alice as unknown as Supa, logSink: () => {} });
    const anon = createClient<Database>(url, s.ANON_KEY ?? "", { auth: { persistSession: false } });
    const strangerApp = createApp({ version: "it", commit: "it", supabase: () => anon as unknown as Supa, logSink: () => {} });
    asAlice = async (p, i = {}) => aliceApp.request(`${BASE}${p}`, i, env);
    asStranger = async (p, i = {}) => strangerApp.request(`${BASE}${p}`, i, env);
  });

  afterAll(async () => {
    const { data: factors } = await db.auth.admin.mfa.listFactors({ userId: ALICE });
    for (const f of factors?.factors ?? []) await db.auth.admin.mfa.deleteFactor({ userId: ALICE, id: f.id });
    await db.from("admins").delete().eq("user_id", ALICE);
    await db.from("feeds").delete().eq("id", feedId);
  });

  async function post(fetcher: typeof asAlice, path: string, fields: Record<string, string>, page: Response) {
    const cookie = /feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const html = await page.clone().text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return fetcher(path, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded", cookie: `feedcal_csrf=${cookie}`, origin: BASE } });
  }

  it("a stranger reports the calendar", async () => {
    const form = await asStranger(`/c/${slug}/report`);
    const res = await post(asStranger, `/c/${slug}/report`, { kind: "spam", details: "selling pills" }, form);
    expect(await res.text()).toContain("Your report was sent");
  });

  it("the admin enrols a second factor, then hides the feed in one click, with an audit record", async () => {
    const enrol = await asAlice("/admin");
    const html = await enrol.clone().text();
    expect(html).toContain("Set up your second factor");
    const secret = /<code>([A-Z2-7]+)<\/code>/.exec(html)?.[1] ?? "";
    const factor = /name="factor" value="([0-9a-f-]{36})"/.exec(html)?.[1] ?? "";
    expect(secret).not.toBe("");

    // Without the second step, actions are refused even for an admin.
    expect((await asAlice(`/admin/feeds/${feedId}/hide`, { method: "POST" })).status).toBe(403);

    const verified = await post(asAlice, "/admin/mfa", { factor, code: totp(secret) }, enrol);
    expect(verified.headers.get("location")).toBe("/admin");
    const queue = await asAlice("/admin");
    const qhtml = await queue.clone().text();
    expect(qhtml).toContain("Admin queue");
    expect(qhtml).toContain("Cheap pills");
    expect(qhtml).toContain("selling pills");

    const hide = await post(asAlice, `/admin/feeds/${feedId}/hide`, { reason: "spam report" }, queue);
    expect(hide.headers.get("location")).toBe("/admin");
    const { data: f } = await db.from("feeds").select("hidden_at").eq("id", feedId).single();
    expect((f as { hidden_at: string | null }).hidden_at).not.toBeNull();
    const { data: audit } = await db.from("admin_audit").select("action, admin_id, reason").eq("target_id", feedId).order("id", { ascending: false }).limit(1).single();
    expect(audit).toEqual({ action: "hide_feed", admin_id: ALICE, reason: "spam report" });
    expect((await asStranger(`/c/${slug}`)).status).toBe(404);
  });

  it("Phase 18: the admin sees operations and runs the alert drill; every alert emails them once", async () => {
    const page = await asAlice("/admin");
    const body = await page.clone().text();
    expect(body).toContain("Operations");
    expect(body).toContain("AI spend today $");
    const before = await db.from("admin_audit").select("id", { count: "exact", head: true }).eq("action", "alert_drill");
    const res = await post(asAlice, "/admin/alert-drill", {}, page);
    expect(await res.text()).toContain("Every alert fired once");
    const after = await db.from("admin_audit").select("id", { count: "exact", head: true }).eq("action", "alert_drill");
    expect((after.count ?? 0) - (before.count ?? 0)).toBe(1);
  });

  it("people who aren't admins get a plain 404 for the console", async () => {
    await db.from("admins").delete().eq("user_id", ALICE);
    expect((await asAlice("/admin")).status).toBe(404);
  });
});
