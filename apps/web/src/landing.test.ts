// D55: the home page for visitors; organizers still go straight to their account.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
const app = (signedIn: boolean) => createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
  auth: { getUser: async () => (signedIn ? { data: { user: { id: "u1", email: "o@example.test" } }, error: null } : { data: { user: null }, error: { message: "x" } }) },
}) as unknown as Supa });

describe("home page (D55)", () => {
  it("visitors see what Calantern is, the 3 steps and both ways in", async () => {
    const res = await app(false).request("https://calantern.test/", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Events that <span>add themselves.</span></h1>");
    expect(html).toContain("↓ becomes"); // the picture of what it does (DESIGN.md: show the calendar)
    expect(html).toContain("Keep emailing like you always do.");
    expect(html).toContain("so nobody types anything in");
    expect(html).toContain('href="/login?next=/feeds/new">Make a calendar</a>');
    expect(html).toContain('href="/directory">Find a calendar</a>');
    expect((html.match(/<span class="n" aria-hidden="true">/g) ?? []).length).toBe(3);
    expect(html).toContain("Got a flyer?");
    expect(html).toContain("<title>Events that add themselves · Calantern</title>");
    expect(html).toContain('<meta name="description" content="Calantern reads');
    expect(html).not.toContain("&lt;meta"); // the description is a tag, not visible text
  });
  it("signed-in organizers go straight to their account", async () => {
    const res = await app(true).request("https://calantern.test/", {}, env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account");
  });
});
