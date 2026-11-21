import { Hono } from "hono";
import { createLogger, Environment, requestIdFrom, type HealthResponse, type Logger } from "@feedcal/shared";
import type { Bindings } from "./env.js";
import { probeDatabase, type DbProbe } from "./db.js";

type Variables = { requestId: string; log: Logger };

export interface AppDeps {
  version: string;
  commit: string;
  probe?: (env: Bindings) => Promise<DbProbe>;
  logSink?: (line: string) => void;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
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
    log.info("request", { method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: Date.now() - started });
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

  app.notFound((c) => c.json({ error: "Not found", request_id: c.get("requestId") }, 404));

  app.onError((err, c) => {
    c.get("log").error("unhandled", { error: err.name });
    return c.json({ error: "Something went wrong on our side. Please try again.", request_id: c.get("requestId") }, 500);
  });

  return app;
}
