// The big Private / Public choice (owner's request, 2026-11-21).
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { visibilityChoice } from "./visibility.js";

describe("Private / Public choice", () => {
  it("offers exactly two big options, Private by default", async () => {
    const html = String(await visibilityChoice(undefined));
    expect(html).toContain("<strong>Private</strong>");
    expect(html).toContain("<strong>Public</strong>");
    expect(html).toContain('value="unlisted" checked');
    expect(html).toContain("Find a calendar");
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
  });
  it("keeps an older 'link only' calendar as it was until changed", async () => {
    expect(String(await visibilityChoice("private"))).toContain('value="private" checked');
    expect(String(await visibilityChoice("public"))).toContain('value="public" checked');
  });

  it("choosing Public for a new calendar creates it private and explains when it can be listed", async () => {
    let inserted: Record<string, unknown> = {};
    const sb = {
      from: () => ({ insert: (row: Record<string, unknown>) => { inserted = row; return { select: () => ({ single: async () => ({ data: { id: "f1" }, error: null }) }) }; } }),
      rpc: async () => ({ data: null, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: "u1", email: "o@example.test" } }, error: null }) },
    } as unknown as Supa;
    const app = createApp({ version: "1", commit: "c", supabase: () => sb, logSink: () => {} });
    const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
    const page = await app.request("https://feedcal.test/feeds/new", {}, env);
    const cookie = /__Host-feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const res = await app.request("https://feedcal.test/feeds/new", { method: "POST", body: new URLSearchParams({ csrf, name: "Room F", category: "school", visibility: "public" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-feedcal_csrf=${cookie}`, origin: "https://feedcal.test" } }, env);
    expect(inserted.visibility).toBe("unlisted");
    expect(res.headers.get("location")).toBe("/feeds/f1/setup?public_later=1"); // D47: next, where the emails come from
  });
});
