// A stranger can't reach another person's share kit, flyer or link rotation (readiness item 10).
// Runs against the real local stack: real Auth sessions, real RLS, real RPCs.
//   npm run test:integration
// Needs `npm run db:start` and `npm run db:reset` (seeded Alice and Bob). CI runs it in the database job.
import { localStatus } from "./local-stack.js";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const BASE = "http://localhost:8788";
const ALICE_FEED = "aaaaaaaa-0000-4000-8000-000000000002"; // Alice's unlisted feed (seed.sql)

interface Local { url: string; anon: string; service: string }

function localStack(): Local {
  const s = localStatus();
  const url = s.API_URL;
  const anon = s.ANON_KEY;
  const service = s.SERVICE_ROLE_KEY; // the local demo key; it never leaves this test process
  if (!url || !anon || !service) throw new Error("Local Supabase isn't running");
  return { url, anon, service };
}

/** A real signed-in session for a seeded user, made the way a magic link would make it. */
async function signedIn(local: Local, email: string): Promise<Supa> {
  const admin = createClient<Database>(local.url, local.service, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink failed for ${email}`);
  const client = createClient<Database>(local.url, local.anon, { auth: { persistSession: false } });
  const verified = await client.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "magiclink" });
  if (verified.error) throw new Error(`verifyOtp failed for ${email}`);
  return client;
}

function appFor(client: Supa, local: Local) {
  const app = createApp({ version: "it", commit: "it", supabase: () => client, logSink: () => {} });
  const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: local.url, SUPABASE_ANON_KEY: local.anon };
  return (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, env);
}

describe.skipIf(!enabled)("a stranger, against the real local stack", () => {
  let alice: ReturnType<typeof appFor>;
  let bob: ReturnType<typeof appFor>;

  beforeAll(async () => {
    const local = localStack();
    alice = appFor(await signedIn(local, "alice@example.test"), local);
    bob = appFor(await signedIn(local, "bob@example.test"), local);
  });

  async function aliceLink(): Promise<string> {
    const res = await alice(`/feeds/${ALICE_FEED}/share`);
    expect(res.status).toBe(200);
    const link = /\/f\/[A-Za-z0-9_-]{43}\.ics/.exec(await res.text())?.[0];
    expect(link).toBeTruthy();
    return link ?? "";
  }

  it("can't open the owner's share kit or flyer", async () => {
    expect((await bob(`/feeds/${ALICE_FEED}/share`)).status).toBe(404);
    expect((await bob(`/feeds/${ALICE_FEED}/flyer`)).status).toBe(404);
  });

  it("can't rotate the owner's link, and the owner's link keeps working", async () => {
    const before = await aliceLink();

    // Bob gets a valid CSRF token from his own account page, so only authorization stops him.
    const page = await bob("/account");
    const cookie = /feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const res = await bob(`/feeds/${ALICE_FEED}/rotate-token`, {
      method: "POST",
      body: new URLSearchParams({ csrf, confirm: "yes" }), // ticked, so the ownership check is what refuses (D45)
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `feedcal_csrf=${cookie}`, origin: BASE },
    });
    expect([403, 404]).toContain(res.status);

    const after = await aliceLink();
    expect(after).toBe(before);
    const ics = await alice(after);
    expect(ics.status).toBe(200);
    expect(await ics.text()).toContain("BEGIN:VCALENDAR");
  });
});
