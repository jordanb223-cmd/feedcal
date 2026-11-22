// Phase 16 (D37) on the local stack: the scheduler's anon-key call purges an account whose grace
// period has passed (and nothing else), and a signed-in user's export holds their own data only.
import { localStatus } from "./local-stack.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";

describe.skipIf(!enabled)("privacy, end to end", { timeout: 60_000 }, () => {
  let url = "";
  let anonKey = "";
  let db: SupabaseClient<Database>;

  beforeAll(() => {
    const s = localStatus();
    url = s.API_URL ?? "";
    anonKey = s.ANON_KEY ?? "";
    db = createClient<Database>(url, s.SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  });

  it("the daily purge (called with the anon key, as pg_cron does) deletes only accounts past their grace period", async () => {
    const stamp = Date.now();
    const { data: due } = await db.auth.admin.createUser({ email: `due-${stamp}@example.test`, email_confirm: true });
    const { data: recent } = await db.auth.admin.createUser({ email: `recent-${stamp}@example.test`, email_confirm: true });
    const dueId = due.user?.id ?? "";
    const recentId = recent.user?.id ?? "";
    await db.from("profiles").update({ deleted_at: new Date(Date.now() - 15 * 86_400_000).toISOString() } as never).eq("id", dueId);
    await db.from("profiles").update({ deleted_at: new Date(Date.now() - 2 * 86_400_000).toISOString() } as never).eq("id", recentId);

    const res = await fetch(`${url}/functions/v1/delete-accounts`, { method: "POST", headers: { authorization: `Bearer ${anonKey}` } });
    expect(res.status).toBe(200);
    expect((await db.auth.admin.getUserById(dueId)).data.user).toBeNull();
    expect((await db.auth.admin.getUserById(recentId)).data.user?.id).toBe(recentId);
    await db.auth.admin.deleteUser(recentId);
  });

  it("export: Alice gets her own feeds and events, with no token hashes", async () => {
    const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: "alice@example.test" });
    const alice = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
    await alice.auth.verifyOtp({ token_hash: link.properties?.hashed_token ?? "", type: "magiclink" });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey };
    const app = createApp({ version: "it", commit: "it", supabase: () => alice as unknown as Supa, logSink: () => {} });
    const res = await app.request("http://localhost:8788/account/export", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="feedcal-export-/);
    const body = await res.text();
    const data = JSON.parse(body) as { account: { email: string }; feeds: { feed: { owner_id: string } }[] };
    expect(data.account.email).toBe("alice@example.test");
    expect(data.feeds.length).toBeGreaterThan(0);
    expect(body).not.toContain("feed_token_hash");
    expect(body).not.toContain("bob@example.test");
  });
});
