import { Hono } from "hono";
import type { Context } from "hono";
import { createLogger, Environment, requestIdFrom, type HealthResponse } from "@feedcal/shared";
import type { Bindings } from "./env.js";
import { probeDatabase, type DbProbe } from "./db.js";
import { registerAuthRoutes } from "./auth.js";
import { registerEmailRoutes } from "./email.js";
import { registerReviewRoutes } from "./review.js";
import { registerChatRoutes } from "./chat.js";
import { registerNotifyRoutes } from "./notify.js";
import { registerSupportRoutes } from "./support.js";
import { registerAssetRoutes } from "./assets.js";
import { registerPrivacyRoutes } from "./privacy.js";
import { registerGmailRoutes } from "./gmail.js";
import { registerImportRoutes } from "./imports.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerContactRoutes } from "./contact.js";
import { registerHelpRoutes } from "./help.js";
import { anonSupabase, registerDirectoryRoutes } from "./directory.js";
import { registerAdminRoutes, registerPolicyRoutes } from "./admin.js";
import { originOf, redactPath, requireSameOrigin, securityHeaders } from "./security.js";
import { registerFeedRoutes } from "./feed.js";
import { registerSubscribeRoutes } from "./subscribe.js";
import { createSupabase } from "./supabase.js";
import type { AppEnv, Supa } from "./types.js";
import { errorPage } from "./views.js";

/**
 * HTML for people, JSON for machines. Browsers send `Accept: text/html`; the health check and
 * calendar files are always machine routes.
 */
export function wantsHtml(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  if (path === "/health" || path.startsWith("/f/") || path.startsWith("/.well-known/")) return false;
  return (c.req.header("accept") ?? "").includes("text/html");
}

export const SECURITY_CONTACT = "https://github.com/jordanb223-cmd/feedcal/security/advisories/new";
export const SECURITY_POLICY = "https://github.com/jordanb223-cmd/feedcal/blob/main/SECURITY.md";
export const SECURITY_TXT_EXPIRES = "2027-11-01T00:00:00.000Z";

export interface AppDeps {
  version: string;
  commit: string;
  probe?: (env: Bindings) => Promise<DbProbe>;
  logSink?: (line: string) => void;
  /** Tests inject a fake; production builds a per-request server client. */
  supabase?: (c: Context<AppEnv>) => Supa;
  /** Public directory queries: the anon key with no session (tests inject a fake). */
  anonSupabase?: (c: Context<AppEnv>) => Supa;
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
    // Routes may set a stricter value (feeds and subscribe hand-offs use no-referrer); keep it.
    for (const [k, v] of Object.entries(securityHeaders(c, c.env?.SUPABASE_URL, c.env?.HSTS_MAX_AGE))) if (!c.res.headers.has(k)) c.header(k, v);
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

  // RFC 9116. Expires must be under a year away; a test fails 30 days before it lapses.
  app.get("/.well-known/security.txt", (c) => {
    c.header("cache-control", "max-age=86400");
    return c.text(
      [
        `Contact: ${SECURITY_CONTACT}`,
        `Expires: ${SECURITY_TXT_EXPIRES}`,
        "Preferred-Languages: en",
        `Policy: ${SECURITY_POLICY}`,
        `Canonical: ${originOf(c)}/.well-known/security.txt`,
        "",
      ].join("\n"),
    );
  });

  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    // Public, cacheable pages never touch the session (no Set-Cookie on a shared-cache response).
    const sessionless = path === "/health" || path.startsWith("/.well-known/") || path === "/robots.txt" || path === "/sitemap.xml"
      || path === "/directory" || path.startsWith("/near/") || path === "/rules" || path === "/terms" || path === "/takedown"
      || path === "/about/costs" || path === "/help/unsubscribe" || path === "/supporters" || path === "/privacy" || path.startsWith("/assets/") || path === "/manifest.webmanifest";
    if (!sessionless) {
      c.set("supabase", makeSupabase(c));
      c.set("user", undefined);
    }
    await next();
  });
  app.use("*", requireSameOrigin);
  registerAuthRoutes(app);
  registerFeedRoutes(app);
  registerSubscribeRoutes(app);
  registerEmailRoutes(app);
  registerReviewRoutes(app);
  registerNotifyRoutes(app);
  registerChatRoutes(app);
  registerDirectoryRoutes(app, deps.anonSupabase ?? anonSupabase);
  registerAdminRoutes(app);
  registerAssetRoutes(app);
  registerPrivacyRoutes(app);
  registerGmailRoutes(app);
  registerImportRoutes(app);
  registerUploadRoutes(app);
  registerContactRoutes(app);
  registerHelpRoutes(app);
  registerPolicyRoutes(app);
  registerSupportRoutes(app, deps.anonSupabase ?? anonSupabase);

  app.notFound((c) => {
    const requestId = c.get("requestId");
    if (wantsHtml(c)) {
      return c.html(errorPage({ title: "Page not found", message: "We couldn't find that page. The link may be mistyped, or the page was removed.", tryThis: "Check the link, or go to your account.", requestId }), 404);
    }
    return c.json({ error: "Not found", request_id: requestId }, 404);
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    c.get("log").error("unhandled", { error: err.name });
    if (wantsHtml(c)) {
      return c.html(errorPage({ title: "Something went wrong", message: "Something went wrong on our side. Nothing you did caused it.", tryThis: "Please go back and try again in a minute.", requestId }), 500);
    }
    return c.json({ error: "Something went wrong on our side. Please try again.", request_id: requestId }, 500);
  });

  return app;
}
