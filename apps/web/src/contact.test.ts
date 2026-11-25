// D63: the contact page's own checks (the database side is pgTAP 028).
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
function app(result: unknown = "ok") {
  const calls: Record<string, unknown>[] = [];
  const a = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) },
    rpc: async (_: string, args: Record<string, unknown>) => { calls.push(args); return { data: result, error: null }; },
  }) as unknown as Supa });
  return { a, calls };
}
const T = "t".repeat(43);
const send = (a: ReturnType<typeof app>["a"], fields: Record<string, string>) => a.request("http://localhost:8788/contact", {
  method: "POST", body: new URLSearchParams({ csrf: T, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:8788", cookie: `feedcal_csrf=${T}` },
}, env);

describe("contact form (D63)", () => {
  it("shows the form, remembering only a Bumpdraft page someone came from", async () => {
    const { a } = app();
    const own = await (await a.request("http://localhost:8788/contact?from=/feeds/abc/flyer", {}, env)).text();
    expect(own).toContain('name="page" value="/feeds/abc/flyer"');
    for (const from of ["https://evil.example/x", "javascript:alert(1)", "//evil.example/x"]) {
      const html = await (await a.request(`http://localhost:8788/contact?from=${encodeURIComponent(from)}`, {}, env)).text();
      expect(html).toContain('name="page" value=""');
    }
  });
  it("sends a message and says thanks", async () => {
    const { a, calls } = app();
    const res = await send(a, { kind: "bug", message: "The flyer is blank", reply_to: "parent@example.test", page: "/feeds/x/flyer" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("your message was sent");
    expect(calls[0]).toMatchObject({ p_kind: "bug", p_message: "The flyer is blank", p_reply_to: "parent@example.test", p_page: "/feeds/x/flyer" });
  });
  it("drops bots that fill the hidden field, without telling them", async () => {
    const { a, calls } = app();
    const res = await send(a, { kind: "other", message: "BUY NOW", website: "http://spam.example" });
    expect(await res.text()).toContain("your message was sent");
    expect(calls).toHaveLength(0);
  });
  it("needs the security token, and explains limits and bad addresses", async () => {
    const noToken = app();
    expect((await noToken.a.request("http://localhost:8788/contact", { method: "POST", body: new URLSearchParams({ kind: "bug", message: "x" }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:8788" } }, env)).status).toBe(403);
    expect(noToken.calls).toHaveLength(0);
    expect((await send(app("too_many").a, { kind: "bug", message: "x" })).status).toBe(429);
    const bad = await send(app("bad_email").a, { kind: "bug", message: "x", reply_to: "nope" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("doesn&#39;t look right");
    expect((await send(app().a, { kind: "bug", message: "   " })).status).toBe(400);
  });
});
