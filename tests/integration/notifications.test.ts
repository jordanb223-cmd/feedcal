// Phase 12 "passes when", end to end on the local stack with real delivery (Mailpit):
// a subscriber's report reaches the owner within a minute, and the owner gets a weekly digest.
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
const MAILPIT = "http://127.0.0.1:54324";

interface MailSummary { ID: string; Subject: string; To: { Address: string }[]; Created: string }

async function inbox(to: string, subjectStarts: string, since: number): Promise<MailSummary | undefined> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=50`);
  const body = (await res.json()) as { messages: MailSummary[] };
  return body.messages.find((m) => m.Subject.startsWith(subjectStarts) && Date.parse(m.Created) >= since - 1000);
}

describe.skipIf(!enabled)("notifications, end to end with real delivery (Mailpit)", { timeout: 60_000 }, () => {
  let db: SupabaseClient<Database>;
  let s: Record<string, string>;
  let request: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(() => {
    s = localStatus();
    const url = s.API_URL ?? "";
    db = createClient<Database>(url, s.SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    // A subscriber has no account: the app runs with the public key only.
    const anon = createClient<Database>(url, s.ANON_KEY ?? "", { auth: { persistSession: false } });
    const app = createApp({ version: "it", commit: "it", supabase: () => anon as unknown as Supa, logSink: () => {} });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: url, SUPABASE_ANON_KEY: s.ANON_KEY ?? "" };
    request = async (path, init = {}) => app.request(`${BASE}${path}`, init, env);
  });

  const send = async () => {
    const res = await fetch(`${s.API_URL}/functions/v1/send-notifications`, { method: "POST", headers: { authorization: `Bearer ${s.SERVICE_ROLE_KEY}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as { sent: number; provider: string };
  };

  it("a subscriber's report reaches the owner's inbox within a minute, with one-click unsubscribe", async () => {
    // Make sure Alice wants report emails (an earlier run may have unsubscribed her).
    await db.from("notification_settings").upsert({ user_id: "11111111-1111-4111-8111-111111111111", instant_reports: true, weekly_digest: true }, { onConflict: "user_id" });
    const { data: ev } = await db.from("events").select("uid, title").eq("feed_id", "aaaaaaaa-0000-4000-8000-000000000001").eq("published", true).limit(1).single();
    const started = Date.now();

    const page = await request(`/report/${encodeURIComponent(ev?.uid ?? "")}`);
    const cookie = /feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const res = await request(`/report/${encodeURIComponent(ev?.uid ?? "")}`, {
      method: "POST", body: new URLSearchParams({ csrf, kind: "wrong_details", details: `It's at 9:30 (${started})` }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `feedcal_csrf=${cookie}`, origin: BASE, "cf-connecting-ip": `198.51.100.${started % 200}` },
    });
    expect(await res.text()).toContain("Your report was sent");

    // pg_cron calls the sender every minute; calling it here is the same step, without the wait.
    expect((await send()).provider).toBe("mailpit");
    const mail = await inbox("alice@example.test", `Someone spotted a problem with "${ev?.title}"`, started);
    expect(mail).toBeTruthy();
    expect(Date.parse(mail?.Created ?? "") - started).toBeLessThan(60_000);

    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${mail?.ID}`)).json()) as { Text: string };
    expect(full.Text).toContain(`It's at 9:30 (${started})`);
    const headers = (await (await fetch(`${MAILPIT}/api/v1/message/${mail?.ID}/headers`)).json()) as Record<string, string[]>;
    expect(headers["List-Unsubscribe-Post"]?.[0]).toBe("List-Unsubscribe=One-Click");
    const unsub = /<([^>]+)>/.exec(headers["List-Unsubscribe"]?.[0] ?? "")?.[1] ?? "";
    expect(unsub).toContain("/unsubscribe?u=11111111-1111-4111-8111-111111111111&k=report&t=");

    // The mail app's one-click POST: no Origin, no cookies.
    const one = await request(new URL(unsub).pathname + new URL(unsub).search, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(one.status).toBe(200);
    expect((await db.from("notification_settings").select("instant_reports").eq("user_id", "11111111-1111-4111-8111-111111111111").single()).data?.instant_reports).toBe(false);
  });

  it("the owner gets a weekly digest with each feed's numbers", async () => {
    await db.rpc("run_weekly_digests");
    await send();
    // Digests are once per ISO week; on a re-run this week, the earlier one is in the inbox.
    // D91: the subject says what is waiting, or "Your Bumpdraft week" when nothing is.
    const mail = (await inbox("alice@example.test", "Needs you this week", 0)) ?? (await inbox("alice@example.test", "Your Bumpdraft week", 0));
    expect(mail).toBeTruthy();
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${mail?.ID}`)).json()) as { Text: string };
    expect(full.Text).toContain("Sutterville Kindergarten");
    expect(full.Text).toMatch(/\d+ events? waiting for your OK\.|Nothing waiting for you\./);
    expect(full.Text).toMatch(/\d+ new events? this week/);
    expect(full.Text).toContain("/help/unsubscribe");
  });
});
