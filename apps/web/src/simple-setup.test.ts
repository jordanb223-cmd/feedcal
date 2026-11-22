// D47: the simpler setup flow. Name it → where do the emails come from → (Gmail) pick the example
// with the defaults already chosen → confirm → "You're set" with the subscribe button.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { newFeedPage, settingsPage } from "./review-views.js";
import { shareKitPage } from "./subscribe-views.js";

const ID = "6dc8d67e-7490-4ffd-b718-4b4eed87274c";
const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon", GMAIL_CLIENT_ID: "client-123.apps.googleusercontent.com" };

function app(status: unknown) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { name: "Room F" }, error: null }) };
  const sb = {
    from: () => chain,
    rpc: async (fn: string) => (fn === "gmail_status" ? { data: status, error: null } : { data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "o@example.test" } }, error: null }) },
  } as unknown as Supa;
  return createApp({ version: "1", commit: "c", supabase: () => sb, logSink: () => {} });
}

describe("simpler setup (D47)", () => {
  it("a new calendar asks only for a name; kind is tucked under More options and defaults to other", async () => {
    const html = String(await newFeedPage({ csrf: "x" }));
    expect(html).toContain('name="name"');
    expect(html).toContain("<summary>More options</summary>");
    expect(html).toContain('<option value="other" selected>');
    expect(html).not.toContain('name="visibility"');
    expect(html).not.toContain('name="zip_code"');
  });

  it("then asks where the emails come from: Gmail (easiest) or forwarding", async () => {
    const html = await (await app({ connected: false }).request(`https://feedcal.test/feeds/${ID}/setup`, {}, env)).text();
    expect(html).toContain("emails come from?");
    expect(html).toContain(`action="/feeds/${ID}/gmail/connect"`);
    expect(html).toContain("Easiest");
    expect(html).toContain(`href="/feeds/${ID}/email?done=created"`);
    expect(html).toContain(`href="/feeds/${ID}/events/new"`);
  });

  it("without Gmail switched on, forwarding is the main choice", async () => {
    const html = await (await app({ connected: false }).request(`https://feedcal.test/feeds/${ID}/setup`, {}, { ENVIRONMENT: env.ENVIRONMENT, SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY } as Bindings)).text();
    expect(html).not.toContain("gmail/connect");
    expect(html).toContain('class="button wide"');
  });

  it("settings show name and who can find it; the rest is folded away", async () => {
    const html = String(await settingsPage({ csrf: "x", feedId: "f1", s: { name: "Room F", description: "", visibility: "unlisted", timezone: "America/Los_Angeles", threshold: 0.85, isOwner: true, zip: null, zipSuggestion: null, editors: [], senders: [] } }));
    expect(html).toContain("<summary>More settings</summary>");
    expect(html).toContain("<summary>Senders, editors and the subscribe link</summary>");
    expect(html.indexOf('name="visibility"')).toBeLessThan(html.indexOf("More settings"));
    expect(html.indexOf('name="timezone"')).toBeGreaterThan(html.indexOf("More settings"));
  });

  it("the end of Gmail setup says you're set and offers the subscribe button first", async () => {
    const kit = { csrf: "x", feedId: ID, name: "Room F", visibility: "unlisted" as const, pageUrl: "https://feedcal.test/c/room-f", feedUrl: "webcal://x", qrSvg: "<svg></svg>", chatText: "", stats: null };
    const html = String(await shareKitPage({ ...kit, ready: true }));
    expect(html).toContain("You're set");
    // The main button copies the share link (owner's request); adding it to your own calendar comes second.
    expect(html).toMatch(/<button type="button" class="wide" data-copy="page-link" aria-live="polite">Copy share link<\/button>/);
    expect(html.indexOf("Copy share link")).toBeLessThan(html.indexOf("Add it to my calendar"));
    expect(html).toContain('<a class="button secondary wide" href="https://feedcal.test/c/room-f">Add it to my calendar</a>');
    expect(String(await shareKitPage(kit))).not.toContain("You're set");
  });
});
