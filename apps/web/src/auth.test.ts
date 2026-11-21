import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { MESSAGES } from "./auth.js";
import { safeNext } from "./security.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const BASE = "http://localhost:8788";
const FAKE_HASH = "fakehashfortests";
/** Messages appear HTML-escaped in pages. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "http://db.test", SUPABASE_ANON_KEY: "anon" };

type AuthError = { code?: string; status?: number; message: string } | null;

function fakeSupabase(opts: { user?: { sub: string; email: string } | null; otpError?: AuthError; verifyError?: AuthError; loginAllowed?: boolean | "error" } = {}) {
  const auth = {
    getUser: vi.fn(async () =>
      opts.user
        ? { data: { user: { id: opts.user.sub, email: opts.user.email } }, error: null }
        : { data: { user: null }, error: { code: "session_not_found", status: 403, message: "x" } },
    ),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: opts.otpError ?? null })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: opts.verifyError ?? null })),
    exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null })),
    signInWithOAuth: vi.fn(async () => ({ data: { url: "http://db.test/auth/v1/authorize?provider=google" }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  const rpc = vi.fn<(fn: string, args?: unknown) => Promise<{ data: unknown; error: unknown }>>(async (fn) => {
    if (fn !== "login_attempt_allowed") return { data: null, error: null };
    if (opts.loginAllowed === "error") return { data: null, error: { code: "PGRST000" } };
    return { data: opts.loginAllowed ?? true, error: null };
  });
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { display_name: null, deleted_at: null } }) }),
      order: async () => ({ data: [] }),
    }),
  }));
  return { client: { auth, rpc, from } as unknown as Supa, auth, rpc };
}

function setup(opts: Parameters<typeof fakeSupabase>[0] = {}, extraEnv: Partial<Bindings> = {}) {
  const fake = fakeSupabase(opts);
  const logs: string[] = [];
  const app = createApp({ version: "1", commit: "c", supabase: () => fake.client, logSink: (l) => logs.push(l) });
  const request = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init, { ...env, ...extraEnv });
  return { ...fake, logs, request };
}

/** GET a page, return its CSRF cookie and the token embedded in the form. */
async function csrfFrom(request: (p: string, i?: RequestInit) => Promise<Response> | Response, path = "/login") {
  const res = await request(path);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = /feedcal_csrf=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const token = /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "";
  return { cookie: `feedcal_csrf=${cookie}`, token, setCookie };
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string>): [string, RequestInit] {
  return [path, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } }];
}

describe("safeNext (redirect allowlist)", () => {
  it.each([
    ["/feeds/1", "/feeds/1"],
    ["//evil.example", "/account"],
    ["/\\evil.example", "/account"],
    ["https://evil.example/x", "/account"],
    ["javascript:alert(1)", "/account"],
    ["/ok\nSet-Cookie:x", "/account"],
    [undefined, "/account"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe("origin checks", () => {
  it("blocks a POST from another site", async () => {
    const { request, auth } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("blocks a POST with neither Origin nor Referer", async () => {
    const { request } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie }));
    expect(res.status).toBe(403);
  });

  it("accepts a same-site Referer when Origin is missing", async () => {
    const { request } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie, referer: `${BASE}/login` }));
    expect(res.status).toBe(200);
  });
});

describe("CSRF", () => {
  it("rejects a form without the token", async () => {
    const { request, auth } = setup();
    const { cookie } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test" }, { cookie, origin: BASE }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(esc(MESSAGES.badForm));
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("rejects a token that doesn't match the cookie", async () => {
    const { request } = setup();
    const { cookie } = await csrfFrom(request);
    const res = await request(...post("/logout-everywhere", { csrf: "x".repeat(43) }, { cookie, origin: BASE }));
    expect(res.status).toBe(403);
  });

  it("sets an HttpOnly, SameSite=Lax cookie, with __Host- and Secure over HTTPS", async () => {
    const { request } = setup();
    expect((await csrfFrom(request)).setCookie).toMatch(/HttpOnly/);
    expect((await csrfFrom(request)).setCookie).toMatch(/SameSite=Lax/);
    const fake = fakeSupabase();
    const app = createApp({ version: "1", commit: "c", supabase: () => fake.client, logSink: () => {} });
    const res = await app.request("https://feedcal.example/login", {}, env);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-feedcal_csrf=.*Secure/);
  });
});

describe("magic link sign-in", () => {
  it("sends the link, lowercases the email, and never logs it", async () => {
    const { request, auth, logs } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "  Parent@Example.TEST ", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: "parent@example.test", options: { emailRedirectTo: `${BASE}/auth/callback` } });
    expect(logs.join("\n").toLowerCase()).not.toContain("parent@example.test");
  });

  it("rejects an invalid email", async () => {
    const { request } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "not-an-email", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(MESSAGES.badEmail));
  });

  it("keeps the typed email when it's invalid, so a typo isn't retyped", async () => {
    const { request } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "jane.doe@example", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('value="jane.doe@example"');
  });

  it("escapes the kept email", async () => {
    const { request } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: '"><script>x</script>', csrf: token }, { cookie, origin: BASE }));
    const body = await res.text();
    expect(body).not.toContain("<script>x");
    expect(body).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("accepts an address with +", async () => {
    const { request, auth } = setup();
    const { cookie, token } = await csrfFrom(request);
    await request(...post("/login", { email: "parent+school@example.test", csrf: token }, { cookie, origin: BASE }));
    expect(auth.signInWithOtp).toHaveBeenCalledWith(expect.objectContaining({ email: "parent+school@example.test" }));
  });

  it("explains that international addresses aren't supported yet", async () => {
    const { request, auth } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "pelé@example.test", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(MESSAGES.intlEmail));
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("checks our own limit with the address and IP before sending", async () => {
    const { request, auth, rpc } = setup();
    const { cookie, token } = await csrfFrom(request);
    await request(...post("/login", { email: "A@Example.test", csrf: token }, { cookie, origin: BASE, "cf-connecting-ip": "198.51.100.4" }));
    expect(rpc).toHaveBeenCalledWith("login_attempt_allowed", { p_email: "a@example.test", p_client_ip: "198.51.100.4" });
    expect(auth.signInWithOtp).toHaveBeenCalled();
  });

  it("over our limit: no email, a plain message, the address kept", async () => {
    const { request, auth } = setup({ loginAllowed: false });
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).toContain(esc(MESSAGES.ourLimit));
    expect(body).toContain('value="a@example.test"');
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("fails closed if the limit can't be checked", async () => {
    const { request, auth } = setup({ loginAllowed: "error" });
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(503);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("explains rate limits", async () => {
    const { request } = setup({ otpError: { code: "over_email_send_rate_limit", status: 429, message: "x" } });
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(429);
    expect(await res.text()).toContain(esc(MESSAGES.tooMany));
  });

  it("shows the same page on other failures, so it never reveals which emails exist", async () => {
    const { request } = setup({ otpError: { code: "signup_disabled", status: 422, message: "x" } });
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/login", { email: "a@example.test", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
  });

  it("opening the link only shows a button; it doesn't use the link", async () => {
    const { request, auth } = setup();
    const res = await request(`/auth/confirm?token_hash=${FAKE_HASH}&type=email`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/auth/confirm"');
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("pressing the button signs in and goes to the account page", async () => {
    const { request, auth } = setup();
    const { cookie, token } = await csrfFrom(request, `/auth/confirm?token_hash=${FAKE_HASH}&type=email`);
    const res = await request(...post("/auth/confirm", { token_hash: FAKE_HASH, type: "email", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: FAKE_HASH, type: "email" });
  });

  it.each(["otp_expired", "flow_state_expired"])("an expired or reused link (%s) fails with a clear message", async (code) => {
    const { request } = setup({ verifyError: { code, status: 403, message: "x" } });
    const { cookie, token } = await csrfFrom(request, `/auth/confirm?token_hash=${FAKE_HASH}&type=email`);
    const res = await request(...post("/auth/confirm", { token_hash: FAKE_HASH, type: "email", csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(MESSAGES.linkExpired));
  });

  it("a malformed link fails with the same message", async () => {
    const { request } = setup();
    const res = await request("/auth/confirm?token_hash=%3Cscript%3E&type=email");
    expect(res.status).toBe(400);
  });
});

describe("Google and the OAuth callback", () => {
  it("is refused while Google sign-in is off", async () => {
    const { request, auth } = setup();
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/auth/google", { csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(400);
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("redirects to the provider with a safe next path when on", async () => {
    const { request, auth } = setup({}, { GOOGLE_SIGN_IN: "on" });
    const { cookie, token } = await csrfFrom(request);
    const res = await request(...post("/auth/google", { csrf: token, next: "//evil.example" }, { cookie, origin: BASE }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://db.test/auth/v1/authorize?provider=google");
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: `${BASE}/auth/callback?next=%2Faccount`, skipBrowserRedirect: true },
    });
  });

  it("the callback never redirects off-site", async () => {
    const { request } = setup();
    const res = await request("/auth/callback?code=0123456789abcdef&next=https://evil.example");
    expect(res.headers.get("location")).toBe("/account");
  });

  it("the callback keeps an on-site next path", async () => {
    const { request } = setup();
    const res = await request("/auth/callback?code=0123456789abcdef&next=/feeds/new");
    expect(res.headers.get("location")).toBe("/feeds/new");
  });

  it("a provider error shows a plain message", async () => {
    const { request } = setup();
    const res = await request("/auth/callback?error=access_denied");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(MESSAGES.signInFailed));
  });
});

describe("sessions and the account page", () => {
  it("sends signed-out users to sign in", async () => {
    const { request } = setup();
    const res = await request("/account");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=/account");
  });

  it("sign out everywhere revokes all sessions", async () => {
    const { request, auth } = setup({ user: { sub: "u1", email: "a@example.test" } });
    const { cookie, token } = await csrfFrom(request, "/account");
    const res = await request(...post("/logout-everywhere", { csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(303);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("deleting needs the confirmation box", async () => {
    const { request, rpc } = setup({ user: { sub: "u1", email: "a@example.test" } });
    const { cookie, token } = await csrfFrom(request, "/account");
    const res = await request(...post("/account/delete", { csrf: token }, { cookie, origin: BASE }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith("request_account_deletion");
    const ok = await request(...post("/account/delete", { csrf: token, confirm: "yes" }, { cookie, origin: BASE }));
    expect(ok.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("request_account_deletion");
  });

  it("the account page shows the grace period and date from the database", async () => {
    const fake = fakeSupabase({ user: { sub: "u1", email: "a@example.test" } });
    fake.rpc.mockImplementation(async (fn: string) =>
      fn === "account_status"
        ? { data: { state: "scheduled_for_deletion", deletion_requested_at: "2026-11-20T10:00:00Z", deletes_on: "2026-12-04T10:00:00Z", grace_days: 14 }, error: null }
        : { data: null, error: null },
    );
    const app = createApp({ version: "1", commit: "c", supabase: () => fake.client, logSink: () => {} });
    const body = await (await app.request(`${BASE}/account`, {}, env)).text();
    expect(body).toContain("will be deleted on <strong>December 4, 2026</strong>");
  });

  it("session pages are never cached", async () => {
    const { request } = setup();
    const res = await request("/login");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });
});
