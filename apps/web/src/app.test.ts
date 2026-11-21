import { describe, expect, it } from "vitest";
import { HealthResponse } from "@feedcal/shared";
import { createApp } from "./app.js";
import { probeDatabase } from "./db.js";
import type { Bindings } from "./env.js";

const env: Bindings = { ENVIRONMENT: "staging", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };

describe("GET /health", () => {
  it("returns 200 and ok when the database answers", async () => {
    const logs: string[] = [];
    const app = createApp({ version: "1.2.3", commit: "abc", probe: async () => ({ reachable: true, latency_ms: 4 }), logSink: (l) => logs.push(l) });
    const res = await app.request("/health", { headers: { "x-request-id": "req-12345678" } }, env);
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({ status: "ok", version: "1.2.3", commit: "abc", environment: "staging", request_id: "req-12345678" });
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({ msg: "request", path: "/health", status: 200, request_id: "req-12345678" });
  });

  it("returns 503 and degraded when the database is unreachable", async () => {
    const app = createApp({ version: "1", commit: "c", probe: async () => ({ reachable: false, latency_ms: null }), logSink: () => {} });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(503);
    expect(HealthResponse.parse(await res.json()).status).toBe("degraded");
  });

  it("unknown routes return a JSON 404 with a request id", async () => {
    const app = createApp({ version: "1", commit: "c", logSink: () => {} });
    const res = await app.request("/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("request_id");
  });
});

describe("probeDatabase", () => {
  it("is unreachable without an anon key", async () => {
    expect(await probeDatabase("http://x", undefined)).toEqual({ reachable: false, latency_ms: null });
  });
  it("is reachable only when the RPC returns true", async () => {
    const ok = (async () => new Response("true", { status: 200 })) as typeof fetch;
    const wrong = (async () => new Response("false", { status: 200 })) as typeof fetch;
    const err = (async () => { throw new Error("down"); }) as typeof fetch;
    expect((await probeDatabase("http://x/", "k", ok)).reachable).toBe(true);
    expect((await probeDatabase("http://x", "k", wrong)).reachable).toBe(false);
    expect((await probeDatabase("http://x", "k", err)).reachable).toBe(false);
  });
});
