// Phase 18 (D38) load test, against the local stack: 1,000 feeds x 100 subscribers polling
// hourly is 100,000 requests an hour, about 28 a second. This sends that rate for 60 seconds
// through the real web app and database, first without ETags, then with If-None-Match (a 304
// for every unchanged feed), and reports latency and bytes.
//   npm run test:load      (needs the local stack; adds 1,000 feeds, then removes them)
import { execFileSync } from "node:child_process";
import { localStatus } from "../integration/local-stack.js";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";

const enabled = process.env.FEEDCAL_LOAD === "1";
const FEEDS = 1000;
const RATE = 28;      // requests per second
const SECONDS = 60;

const psql = (sql: string) =>
  execFileSync("docker", ["exec", "-i", "supabase_db_feedcal", "psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

describe.skipIf(!enabled)("feed endpoint under load", { timeout: 300_000 }, () => {
  let tokens: string[] = [];
  let request: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(() => {
    psql(`insert into public.feeds (owner_id, name, slug, visibility)
          select '11111111-1111-4111-8111-111111111111', 'Load ' || g, 'load-' || g, 'private' from generate_series(1, ${FEEDS}) g;
          insert into public.events (feed_id, title, starts_at, published)
          select f.id, 'Practice ' || n, now() + (n || ' days')::interval, true from public.feeds f, generate_series(1, 8) n where f.slug like 'load-%';`);
    tokens = psql(`select ds.decrypted_secret from public.feeds f join vault.decrypted_secrets ds on ds.id = f.feed_token_secret_id where f.slug like 'load-%'`).trim().split("\n");
    const s = localStatus();
    const anon = createClient<Database>(s.API_URL ?? "", s.ANON_KEY ?? "", { auth: { persistSession: false } });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: s.API_URL ?? "", SUPABASE_ANON_KEY: s.ANON_KEY ?? "" };
    const app = createApp({ version: "load", commit: "load", supabase: () => anon as unknown as Supa, logSink: () => {} });
    request = async (p, i = {}) => app.request(`http://localhost:8788${p}`, i, env);
  }, 180_000);

  afterAll(() => {
    psql(`delete from public.feeds where slug like 'load-%'`);
  }, 180_000);

  async function run(label: string, etags: Map<string, string> | null) {
    const latencies: number[] = [];
    const statuses: Record<number, number> = {};
    let bytes = 0;
    let i = 0;
    const started = Date.now();
    const inflight: Promise<void>[] = [];
    for (let second = 0; second < SECONDS; second++) {
      const tickStart = Date.now();
      for (let k = 0; k < RATE; k++) {
        const token = tokens[i++ % tokens.length] ?? "";
        const headers: Record<string, string> = { "user-agent": "Google-Calendar-Importer" };
        const tag = etags?.get(token);
        if (tag) headers["if-none-match"] = tag;
        inflight.push((async () => {
          const t0 = performance.now();
          const res = await request(`/f/${token}.ics`, { headers });
          const body = await res.arrayBuffer();
          latencies.push(performance.now() - t0);
          statuses[res.status] = (statuses[res.status] ?? 0) + 1;
          bytes += body.byteLength;
          if (etags && res.status === 200) etags.set(token, res.headers.get("etag") ?? "");
        })());
      }
      const wait = 1000 - (Date.now() - tickStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await Promise.all(inflight);
    const result = { label, requests: latencies.length, seconds: Math.round((Date.now() - started) / 100) / 10, statuses,
      p50_ms: Math.round(pct(latencies, 50)), p95_ms: Math.round(pct(latencies, 95)), p99_ms: Math.round(pct(latencies, 99)),
      kb_per_request: Math.round(bytes / latencies.length / 10.24) / 100 };
    console.log(JSON.stringify(result));
    return result;
  }

  it("serves 28 requests a second for a minute; with ETags, unchanged feeds are 304s with no body", async () => {
    const plain = await run("no_etag", null);
    const etags = new Map<string, string>();
    for (const t of tokens) {
      const res = await request(`/f/${t}.ics`);
      etags.set(t, res.headers.get("etag") ?? "");
      await res.arrayBuffer();
    }
    const cached = await run("with_etag", etags);
    expect(plain.statuses[200]).toBe(plain.requests);
    expect(cached.statuses[304]).toBe(cached.requests);
    expect(cached.kb_per_request).toBe(0);
    expect(plain.p95_ms).toBeLessThan(500);
    expect(cached.p95_ms).toBeLessThan(500);
  });
});
