// D44: the calendar's area (ZIP) is suggested from its emails and only asked for when Public;
// plus the notices for subscribers, organizers and the privacy policy.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { visibilityChoice } from "./visibility.js";
import { SENDER_NOTE } from "./email-views.js";
import { NOTE_ACCURACY, NOTE_UNOFFICIAL } from "./subscribe-views.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };

describe("area (ZIP) on the Public choice", () => {
  it("fills in a ZIP found in the calendar's addresses and says where it came from", async () => {
    const html = String(await visibilityChoice("unlisted", { zip: null, suggestion: { zip: "95818", places: 3 } }));
    expect(html).toContain('name="zip_code"');
    expect(html).toContain('value="95818"');
    expect(html).toContain("Found in 3 addresses");
  });
  it("a saved ZIP wins over a suggestion; with neither, it's optional and empty", async () => {
    expect(String(await visibilityChoice("public", { zip: "95822", suggestion: { zip: "95818", places: 3 } }))).toContain('value="95822"');
    const none = String(await visibilityChoice("unlisted"));
    expect(none).toContain('value=""');
    expect(none).toContain("Optional");
    expect(none).toContain('placeholder="5 digits"'); // not a real-looking ZIP that could pass for a filled-in value
  });
  it("says what Public means, including the area being shown", async () => {
    expect(String(await visibilityChoice("public"))).toContain("anyone can find it and see every event, and its area is shown");
  });
});

describe("new calendar with a ZIP", () => {
  function app(knownZips: string[]) {
    let inserted: Record<string, unknown> = {};
    const sb = {
      from: (t: string) => t === "zip_codes"
        ? { select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: async () => ({ data: knownZips.includes(v) ? { zip: v } : null, error: null }) }) }) }
        : { insert: (row: Record<string, unknown>) => { inserted = row; return { select: () => ({ single: async () => ({ data: { id: "f1" }, error: null }) }) }; } },
      rpc: async () => ({ data: null, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: "u1", email: "o@example.test" } }, error: null }) },
    } as unknown as Supa;
    const a = createApp({ version: "1", commit: "c", supabase: () => sb, logSink: () => {} });
    async function create(fields: Record<string, string>) {
      const page = await a.request("https://feedcal.test/feeds/new", {}, env);
      const cookie = /__Host-feedcal_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      return a.request("https://feedcal.test/feeds/new", { method: "POST", body: new URLSearchParams({ csrf, name: "Room F", category: "school", ...fields }),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-feedcal_csrf=${cookie}`, origin: "https://feedcal.test" } }, env);
    }
    return { create, inserted: () => inserted };
  }
  it("saves a known ZIP", async () => {
    const t = app(["95818"]);
    await t.create({ visibility: "public", zip_code: "95818" });
    expect(t.inserted().zip_code).toBe("95818");
  });
  it("refuses an unknown ZIP with a plain message", async () => {
    const t = app(["95818"]);
    const res = await t.create({ visibility: "public", zip_code: "00000" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("know the ZIP code 00000");
  });
  it("no ZIP is fine", async () => {
    const t = app([]);
    await t.create({ visibility: "unlisted", zip_code: "" });
    expect(t.inserted().zip_code).toBe(null);
  });
});

describe("notices", () => {
  const anonApp = (sbFrom?: unknown) => createApp({ version: "1", commit: "c", supabase: () => ({ from: sbFrom, rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null }, error: null }) } }) as unknown as Supa, logSink: () => {} });
  it("the privacy policy has a Gmail section with the Limited Use statement", async () => {
    const html = await (await anonApp().request("https://feedcal.test/privacy", {}, env)).text();
    expect(html).toContain("If you connect Gmail");
    expect(html).toContain("from the one sender you picked");
    expect(html).toContain("including the Limited Use requirements");
  });
  it("subscriber and sender notes say plainly what to expect", () => {
    expect(NOTE_ACCURACY).toContain("can make mistakes");
    expect(NOTE_UNOFFICIAL).toContain("Not run or endorsed");
    expect(SENDER_NOTE).toContain("clearly states the date");
  });
});
