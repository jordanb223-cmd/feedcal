import { Hono } from "hono";
import type { Context } from "hono";
import { createLogger, Environment, requestIdFrom, type HealthResponse } from "@feedcal/shared";
import type { Bindings } from "./env.js";
import { probeDatabase, type DbProbe } from "./db.js";
import { registerAuthRoutes } from "./auth.js";
import { redactPath, requireSameOrigin } from "./security.js";
import { registerFeedRoutes } from "./feed.js";
import { registerSubscribeRoutes } from "./subscribe.js";
import { createSupabase } from "./supabase.js";
import type { AppEnv, Supa } from "./types.js";

export interface AppDeps {
  version: string;
  commit: string;
  probe?: (env: Bindings) => Promise<DbProbe>;
  logSink?: (line: string) => void;
  /** Tests inject a fake; production builds a per-request server client. */
  supabase?: (c: Context<AppEnv>) => Supa;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const makeSupabase = deps.supabase ?? createSupabase;
  const probe = deps.probe ?? ((env: Bindings) => probeDatabase(env.SUPABASE_URL, env.SUPABASE_ANON_KEY));

  app.use("*", async (c, next) => {
    const requestId = requestIdFrom(c.req.header("x-request-id"));
    const log = createLogger({ service: "web", request_id: requestId }, deps.logSink);
    c.set("requestId", requestId);
    c.set("log", log);
    const started = Date.now();
    await next();
    c.header("x-request-id", requestId);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("content-security-policy", "frame-ancestors 'none'");
    // Pages that read or set the session must never be cached by Cloudflare or a proxy.
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "private, no-store");
    log.info("request", { method: c.req.method, path: redactPath(new URL(c.req.url).pathname), status: c.res.status, ms: Date.now() - started });
  });

  app.get("/health", async (c) => {
    const parsedEnv = Environment.safeParse(c.env.ENVIRONMENT);
    const db = await probe(c.env);
    const body: HealthResponse = {
      status: db.reachable ? "ok" : "degraded",
      version: deps.version,
      commit: deps.commit,
      environment: parsedEnv.success ? parsedEnv.data : "local",
      database: db,
      request_id: c.get("requestId"),
    };
    c.header("cache-control", "no-store");
    return c.json(body, db.reachable ? 200 : 503);
  });

  app.use("*", async (c, next) => {
    if (new URL(c.req.url).pathname !== "/health") {
      c.set("supabase", makeSupabase(c));
      c.set("user", undefined);
    }
    await next();
  });
  app.use("*", requireSameOrigin);
  registerAuthRoutes(app);
  registerFeedRoutes(app);
  registerSubscribeRoutes(app);

  app.notFound((c) => c.json({ error: "Not found", request_id: c.get("requestId") }, 404));

  app.onError((err, c) => {
    c.get("log").error("unhandled", { error: err.name });
    return c.json({ error: "Something went wrong on our side. Please try again.", request_id: c.get("requestId") }, 500);
  });

  return app;
}
