// Phase 13 "passes when": "95818" or "Land Park soccer" returns sensible ranked results in under
// 300 ms. 1,000 synthetic public feeds (fake 99xxx ZIPs) are added, searched through the real app
// and the anon key, then removed.
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const OWNER = "11111111-1111-4111-8111-111111111111";

describe.skipIf(!enabled)("directory performance and ranking (local stack)", { timeout: 120_000 }, () => {
  let db: SupabaseClient<Database>;
  let request: (p: string) => Promise<Response>;
  const tag = `perf${Date.now()}`;

  beforeAll(async () => {
    const s = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
    db = createClient<Database>(s.API_URL ?? "", s.SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const zips = Array.from({ length: 40 }, (_, i) => ({ zip: `99${String(800 + i)}`, location: `SRID=4326;POINT(${-121.5 + (i % 8) * 0.03} ${38.55 + Math.floor(i / 8) * 0.03})`, city: "Testville", state: "CA" }));
    await db.from("zip_codes").upsert(zips as never, { onConflict: "zip" });
    const kinds = ["school", "youth sports", "community", "library", "faith"];
    const feeds = Array.from({ length: 1000 }, (_, i) => ({
      owner_id: OWNER, name: i === 7 ? `Land Park Soccer ${tag}` : `${kinds[i % 5]} group ${i} ${tag}`, slug: `${tag}-${i}`,
      description: i === 7 ? "Youth soccer in Land Park" : `Events for group ${i}`, category: kinds[i % 5], zip_code: zips[i % 40]?.zip, visibility: "public",
    }));
    for (let i = 0; i < feeds.length; i += 250) {
      const { error } = await db.from("feeds").insert(feeds.slice(i, i + 250) as never);
      if (error) throw new Error(error.message);
    }
    const app = createApp({ version: "it", commit: "it", logSink: () => {} });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: s.API_URL ?? "", SUPABASE_ANON_KEY: s.ANON_KEY ?? "" };
    request = (p) => app.request(`http://localhost:8788${p}`, {}, env) as Promise<Response>;
  });

  afterAll(async () => {
    await db.from("feeds").delete().like("slug", `${tag}-%`);
    await db.from("zip_codes").delete().like("zip", "998%");
  });

  async function median(path: string): Promise<{ ms: number; body: string }> {
    let body = "";
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const res = await request(path);
      body = await res.text();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { ms: times[3] ?? 0, body };
  }

  it('"Land Park soccer" finds the club first, in under 300 ms', async () => {
    const { ms, body } = await median(`/directory?q=${encodeURIComponent("Land Park soccer")}`);
    const first = /<a href="\/c\/([^"]+)">/.exec(body)?.[1];
    expect(first).toBe(`${tag}-7`);
    expect(ms).toBeLessThan(300);
  });

  it("a ZIP search returns nearby feeds, nearest first, in under 300 ms", async () => {
    const { ms, body } = await median("/near/99800?miles=5");
    const miles = [...body.matchAll(/(\d+(?:\.\d+)?) mi</g)].map((m) => Number(m[1]));
    expect(miles.length).toBeGreaterThan(5);
    expect(miles).toEqual([...miles].sort((a, b) => a - b));
    expect(Math.max(...miles)).toBeLessThanOrEqual(5);
    expect(ms).toBeLessThan(300);
  });
});
