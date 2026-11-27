// D92: what the policy pages and the sign-in page must say.
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bindings } from "./env.js";
import type { Supa } from "./types.js";

const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: "https://ref.supabase.co", SUPABASE_ANON_KEY: "anon" };
const chain: Record<string, unknown> = {};
for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
(chain as { then: unknown }).then = (r: (v: unknown) => void) => r({ data: [], error: null });
const app = createApp({ version: "1", commit: "c", logSink: () => {}, supabase: () => ({
  auth: { getUser: async () => ({ data: { user: null }, error: { message: "x" } }) },
  from: () => chain, rpc: async () => ({ data: [], error: null }),
}) as unknown as Supa });
const page = async (path: string) => (await app.request(`https://bumpdraft.test${path}`, {}, env)).text();

describe("policy pages (D92)", () => {
  it("the sign-in page says that signing in accepts the terms, before the button", async () => {
    const html = await page("/login");
    const agree = html.indexOf("By signing in, you agree to");
    expect(agree).toBeGreaterThan(-1);
    expect(agree).toBeLessThan(html.indexOf("Email me a sign-in link"));
    for (const href of ["/terms", "/rules", "/privacy"]) expect(html.slice(agree, agree + 400)).toContain(`href="${href}"`);
  });

  it("the terms give an age, the AI's limits, copyright and how changes are announced", async () => {
    const html = await page("/terms");
    for (const s of ["18 or older", "What the AI does.", "repeatedly infringe copyright", "at least 14 days before"]) expect(html).toContain(s);
  });

  it("the takedown page lists what a copyright notice and a counter-notice need", async () => {
    const html = await page("/takedown");
    expect(html).toContain('id="copyright"');
    for (const s of ["under penalty of perjury", "counter-notice", "10 to 14 business days", "Repeat infringers."]) expect(html).toContain(s);
  });

  it("the privacy page covers questions, chat, Google, children and its own date", async () => {
    const html = await page("/privacy");
    for (const s of ["Questions to an organizer:", "Event chat:", "until 30 days after the event is over", "and Google (only if", "Do Not Track", "children under 13", "Changes to this page"]) expect(html).toContain(s);
    expect(html).toMatch(/Last changed [A-Z][a-z]+ \d{1,2}, \d{4}\./);
  });

  it("the rules cover chats and questions", async () => {
    expect(await page("/rules")).toContain("The same rules apply in event chats and in questions to organizers.");
  });

  it("every policy page still says it is a draft", async () => {
    for (const p of ["/terms", "/rules", "/takedown", "/privacy"]) expect(await page(p)).toContain("To be reviewed by a lawyer");
  });
});
