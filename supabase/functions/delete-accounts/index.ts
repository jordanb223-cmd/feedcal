// Edge Function: delete accounts whose 14-day grace period has passed. pg_cron calls it daily
// with the anon key, like storage-trash (D37): it only ever purges accounts that are already
// due, so a stranger calling it can't delete anything early. Supabase's gateway still requires
// a valid project JWT (verify_jwt).
import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { runPurge, type PurgeClient } from "./purge.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!url || !serviceKey) return json({ error: "Not configured." }, 500);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const client: PurgeClient = {
    async dueAccounts() {
      const { data, error } = await admin.rpc("due_account_deletions");
      if (error) throw new Error("due_account_deletions failed");
      return (data ?? []) as string[];
    },
    async purgeData(userId) {
      const { data, error } = await admin.rpc("purge_account_data", { p_user_id: userId });
      if (error) throw new Error("purge_account_data failed");
      return data as { feeds_transferred: number; feeds_deleted: number };
    },
    async deleteAuthUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error && error.status === 404) return false;
      if (error) throw new Error("deleteUser failed");
      return true;
    },
  };

  const result = await runPurge(client);
  // Counts only: no user ids or emails in logs.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "account_purge", service: "delete-accounts", request_id: requestId, ...result }));
  return json({ ...result, request_id: requestId });
});
