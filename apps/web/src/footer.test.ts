// D62: every page carries the short disclaimer; the privacy page says what cookies exist.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";
import { FOOTER_DISCLAIMER } from "./views.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
  auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) },
}) as unknown as Supa });
const page = async (p: string) => (await app.request(`https://calantern.test${p}`, { headers: { accept: "text/html" } }, env)).text();

describe("footer and cookies (D62)", () => {
  it.each(["/", "/login", "/privacy", "/terms", "/rules", "/takedown", "/about/costs", "/nope"])("%s shows the disclaimer in the footer", async (p) => {
    const html = await page(p);
    // Compare plain text (no pattern built from the sentence): it must sit inside the footer.
    const shown = FOOTER_DISCLAIMER.replaceAll("&", "&amp;").replaceAll("'", "&#39;");
    const footer = html.slice(html.indexOf("<footer"));
    expect(html.indexOf("<footer")).toBeGreaterThan(-1);
    expect(footer).toContain(`<p>${shown}</p>`);
    expect(footer).toContain('<a href="/contact">Contact</a>');
  });
  it("the privacy page lists the cookies and says there are no trackers", async () => {
    const html = await page("/privacy");
    expect(html).toContain('<h2 id="cookies">Cookies and trackers</h2>');
    for (const want of ["security cookie", "Sign-in cookies", "deleted when you close your browser", "No trackers, ads or analytics"]) expect(html).toContain(want);
  });
});
