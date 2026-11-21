import { describe, expect, it } from "vitest";
import { HealthResponse } from "@feedcal/shared";
import { createApp, SECURITY_TXT_EXPIRES } from "./app.js";
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

describe("error pages", () => {
  const html = { accept: "text/html,application/xhtml+xml" };

  it("a browser gets an HTML 404 with the request id", async () => {
    const app = createApp({ version: "1", commit: "c", logSink: () => {} });
    const res = await app.request("/nope", { headers: { ...html, "x-request-id": "req-abcdef12" } }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).toContain("req-abcdef12");
  });

  it("an unexpected error shows a plain-English HTML page to a browser, JSON to a machine", async () => {
    const boom = () => { throw new Error("db exploded with secret detail"); };
    const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: boom as never });
    const page = await app.request("/login", { headers: { ...html, "x-request-id": "req-12345678" } }, env);
    expect(page.status).toBe(500);
    const body = await page.text();
    expect(body).toContain("Something went wrong");
    expect(body).toContain("req-12345678");
    expect(body).not.toContain("secret detail");
    const api = await app.request("/login", {}, env);
    expect(api.status).toBe(500);
    expect(await api.json()).toHaveProperty("request_id");
  });

  it("calendar files and health never get HTML, even when a browser asks", async () => {
    const app = createApp({ version: "1", commit: "c", logSink: () => {} });
    const res = await app.request("/f/nope/extra", { headers: html }, env);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("/.well-known/security.txt (RFC 9116)", () => {
  it("has the required fields and no session work", async () => {
    const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => { throw new Error("no db needed"); } });
    const res = await app.request("https://feedcal.example/.well-known/security.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toMatch(/^Contact: https:\/\//m);
    expect(body).toMatch(/^Expires: \d{4}-\d\d-\d\dT/m);
    expect(body).toContain("Canonical: https://feedcal.example/.well-known/security.txt");
  });

  it("is renewed at least 30 days before it expires (update SECURITY_TXT_EXPIRES)", () => {
    const daysLeft = (Date.parse(SECURITY_TXT_EXPIRES) - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(30);
    expect(daysLeft).toBeLessThanOrEqual(366);
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
