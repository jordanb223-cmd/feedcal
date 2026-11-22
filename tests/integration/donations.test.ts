// Phase 15 "passes when", on the local stack: a signed Buy Me a Coffee webhook (the recorded
// payload shape from bmc.test.ts) reaches the real bmc-webhook Edge Function, counts once however
// often it's delivered, and a forged one is refused.
//   npm run test:integration   (needs BMC_WEBHOOK_SECRET in supabase/functions/.env; see SETUP §12)
import { createHmac } from "node:crypto";
import { localStatus } from "./local-stack.js";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";

describe.skipIf(!enabled)("Buy Me a Coffee webhook, end to end", { timeout: 60_000 }, () => {
  let url = "";
  let secret = "";
  let db: SupabaseClient<Database>;
  const eventId = Date.now();
  const email = `supporter-${eventId}@example.test`;
  const body = JSON.stringify({ event_id: eventId, type: "donation.created", live_mode: true, created: Math.floor(eventId / 1000), attempt: 1,
    data: { supporter_name: "Sam", supporter_email: email, amount: 5, currency: "USD", support_note: "for the calendars" } });
  const send = (b: string, sig: string) => fetch(`${url}/functions/v1/bmc-webhook`, { method: "POST", body: b, headers: { "content-type": "application/json", "x-signature-sha256": sig } });

  beforeAll(() => {
    const s = localStatus();
    url = s.API_URL ?? "";
    const env = readFileSync(new URL("../../supabase/functions/.env", import.meta.url), "utf8");
    secret = /^BMC_WEBHOOK_SECRET=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
    if (!url || !secret) throw new Error("Local stack or BMC_WEBHOOK_SECRET missing");
    db = createClient<Database>(url, s.SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  });

  it("refuses a forged webhook", async () => {
    const res = await send(body, createHmac("sha256", "not-the-secret").update(body).digest("hex"));
    expect(res.status).toBe(401);
  });

  it("applies a signed donation once, however often it's delivered", async () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const first = await send(body, sig);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: "applied" });
    expect(await (await send(body, sig)).json()).toEqual({ ok: true, outcome: "duplicate" });
    const { data } = await db.rpc("record_bmc_event", { p_event_id: eventId, p_type: "donation.created", p_live: true, p_email: email, p_name: null, p_amount_cents: 500, p_currency: "USD" } as never);
    expect(data).toBe("duplicate");
  });
});
