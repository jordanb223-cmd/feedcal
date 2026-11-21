import type { Context, Hono } from "hono";
import { z } from "zod";
import { csrfToken, csrfValid, originOf, safeNext } from "./security.js";
import type { AppEnv, SessionUser } from "./types.js";
import { accountPage, checkEmailPage, confirmPage, loginPage, messagePage } from "./views.js";

export const MESSAGES = {
  linkExpired: "This sign-in link has expired or was already used. Each link works once and lasts 15 minutes. Please ask for a new one.",
  badForm: "Your session timed out. Please try again.",
  badEmail: "Please enter a valid email address.",
  tooMany: "Too many sign-in emails were sent. Please wait a few minutes and try again.",
  signInFailed: "We couldn't sign you in. Please try again.",
  googleOff: "Google sign-in isn't available yet. Please use the email link.",
} as const;

const LoginForm = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email()) });
const ConfirmForm = z.object({
  token_hash: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
  type: z.enum(["email", "magiclink", "signup"]),
});
const CallbackQuery = z.object({ code: z.string().min(10).max(200).optional(), next: z.string().optional(), error: z.string().optional() });

/**
 * The signed-in user, checked with the Auth server on every request. Cached for the request.
 * getUser(), not getClaims(): with asymmetric signing keys getClaims() only checks the JWT
 * signature locally, so a session revoked by "sign out everywhere" would keep working until
 * its access token expired (up to an hour). The server check rejects it at once. See D15.
 */
export async function currentUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const cached = c.get("user");
  if (cached !== undefined) return cached;
  const { data, error } = await c.get("supabase").auth.getUser();
  const user: SessionUser | null = !error && data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
  c.set("user", user);
  return user;
}

async function form(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string"));
}

function googleEnabled(c: Context<AppEnv>): boolean {
  return c.env.GOOGLE_SIGN_IN === "on";
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.get("/", async (c) => c.redirect((await currentUser(c)) ? "/account" : "/login", 303));

  app.get("/login", async (c) => {
    const next = safeNext(c.req.query("next"));
    if (await currentUser(c)) return c.redirect(next, 303);
    return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: googleEnabled(c), next }));
  });

  app.post("/login", async (c) => {
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: googleEnabled(c), error: MESSAGES.badForm }), 403);
    const parsed = LoginForm.safeParse(body);
    if (!parsed.success) {
      return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: googleEnabled(c), error: MESSAGES.badEmail }), 400);
    }
    const { error } = await c.get("supabase").auth.signInWithOtp({
      email: parsed.data.email,
      options: { emailRedirectTo: `${originOf(c)}/auth/callback` },
    });
    if (error) {
      const rateLimited = error.status === 429 || error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit";
      c.get("log").warn("login_link_failed", { code: error.code ?? "unknown", status: error.status ?? null });
      if (rateLimited) return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: googleEnabled(c), error: MESSAGES.tooMany }), 429);
      // Any other failure gets the same page as success, so the form never reveals which addresses exist.
    } else {
      c.get("log").info("login_link_sent");
    }
    return c.html(checkEmailPage());
  });

  // The email link lands here. GET only shows a button: link scanners that open URLs
  // automatically can't use up the one-time link.
  app.get("/auth/confirm", (c) => {
    const parsed = ConfirmForm.safeParse({ token_hash: c.req.query("token_hash"), type: c.req.query("type") });
    if (!parsed.success) return c.html(messagePage("Link not valid", MESSAGES.linkExpired, { href: "/login", text: "Get a new link" }), 400);
    return c.html(confirmPage({ csrf: csrfToken(c), tokenHash: parsed.data.token_hash, type: parsed.data.type }));
  });

  app.post("/auth/confirm", async (c) => {
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/login", text: "Sign in" }), 403);
    const parsed = ConfirmForm.safeParse(body);
    if (!parsed.success) return c.html(messagePage("Link not valid", MESSAGES.linkExpired, { href: "/login", text: "Get a new link" }), 400);
    const { error } = await c.get("supabase").auth.verifyOtp({ token_hash: parsed.data.token_hash, type: "email" });
    if (error) {
      c.get("log").info("login_link_rejected", { code: error.code ?? "unknown" });
      return c.html(messagePage("Link expired", MESSAGES.linkExpired, { href: "/login", text: "Get a new link" }), 400);
    }
    c.get("log").info("signed_in", { method: "email" });
    return c.redirect("/account", 303);
  });

  app.post("/auth/google", async (c) => {
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: googleEnabled(c), error: MESSAGES.badForm }), 403);
    if (!googleEnabled(c)) return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: false, error: MESSAGES.googleOff }), 400);
    const next = safeNext(typeof body.next === "string" ? body.next : undefined);
    // No `scopes` option: Supabase's Google provider asks for basic profile and email only
    // (UNVERIFIED against Google's consent screen until the owner's OAuth client exists).
    const { data, error } = await c.get("supabase").auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${originOf(c)}/auth/callback?next=${encodeURIComponent(next)}`, skipBrowserRedirect: true },
    });
    if (error || !data.url) return c.html(loginPage({ csrf: csrfToken(c), googleEnabled: true, error: MESSAGES.signInFailed }), 502);
    return c.redirect(data.url, 303);
  });

  // OAuth (PKCE) callback.
  app.get("/auth/callback", async (c) => {
    const q = CallbackQuery.safeParse(c.req.query());
    if (!q.success || q.data.error || !q.data.code) {
      return c.html(messagePage("Sign-in didn't finish", MESSAGES.signInFailed, { href: "/login", text: "Try again" }), 400);
    }
    const { error } = await c.get("supabase").auth.exchangeCodeForSession(q.data.code);
    if (error) {
      c.get("log").info("oauth_callback_rejected", { code: error.code ?? "unknown" });
      return c.html(messagePage("Sign-in didn't finish", MESSAGES.signInFailed, { href: "/login", text: "Try again" }), 400);
    }
    c.get("log").info("signed_in", { method: "oauth" });
    return c.redirect(safeNext(q.data.next), 303);
  });

  const signOut = (scope: "local" | "global") => async (c: Context<AppEnv>) => {
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/account", text: "Back" }), 403);
    await c.get("supabase").auth.signOut({ scope });
    c.get("log").info("signed_out", { scope });
    return c.redirect("/login", 303);
  };
  app.post("/logout", signOut("local"));
  app.post("/logout-everywhere", signOut("global"));

  app.get("/account", async (c) => {
    const user = await currentUser(c);
    if (!user) return c.redirect("/login?next=/account", 303);
    return renderAccount(c, user);
  });

  app.post("/account/delete", async (c) => {
    const user = await currentUser(c);
    if (!user) return c.redirect("/login", 303);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return renderAccount(c, user, MESSAGES.badForm, 403);
    if (body.confirm !== "yes") return renderAccount(c, user, "Please tick the box to confirm.", 400);
    const { error } = await c.get("supabase").rpc("request_account_deletion");
    if (error) throw new Error("request_account_deletion failed");
    c.get("log").info("account_deletion_requested");
    return renderAccount(c, user, "Your account is scheduled for deletion. You can change your mind any time in the next 14 days.");
  });

  app.post("/account/cancel-delete", async (c) => {
    const user = await currentUser(c);
    if (!user) return c.redirect("/login", 303);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return renderAccount(c, user, MESSAGES.badForm, 403);
    const { error } = await c.get("supabase").rpc("cancel_account_deletion");
    if (error) throw new Error("cancel_account_deletion failed");
    c.get("log").info("account_deletion_cancelled");
    return renderAccount(c, user, "Your account will not be deleted.");
  });
}

async function renderAccount(c: Context<AppEnv>, user: SessionUser, notice?: string, status: 200 | 400 | 403 = 200) {
  const { data } = await c.get("supabase").from("profiles").select("display_name, deleted_at").eq("id", user.id).maybeSingle();
  const deletionDate = data?.deleted_at
    ? new Date(new Date(data.deleted_at).getTime() + 14 * 24 * 3600 * 1000).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })
    : null;
  return c.html(
    accountPage({ csrf: csrfToken(c), email: user.email, displayName: data?.display_name ?? null, deletionDate, ...(notice ? { notice } : {}) }),
    status,
  );
}
