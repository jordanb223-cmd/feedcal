// Phase 15 routes (D36): what Feedcal costs, how to support it (a plain link to Buy Me a Coffee;
// no third-party script), the opt-in supporters list, and linking support to an account.
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { anonSupabase } from "./directory.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv, Supa } from "./types.js";
import { layout, messagePage, publicLayout } from "./views.js";

const Username = z.string().regex(/^[A-Za-z0-9_-]{1,50}$/);
const Status = z.object({ linked: z.boolean(), member: z.boolean(), donations: z.number(), list_publicly: z.boolean(), since: z.string().nullable() });
const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;

/** The Buy Me a Coffee page, only when BMC_USERNAME is configured and valid. */
export function bmcUrl(username: string | undefined): string | null {
  const u = Username.safeParse(username);
  return u.success ? `https://buymeacoffee.com/${u.data}` : null;
}

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

export function registerSupportRoutes(app: Hono<AppEnv>, anon: (c: Context<AppEnv>) => Supa = anonSupabase): void {
  app.get("/about/costs", (c) => {
    const bmc = bmcUrl(c.env.BMC_USERNAME);
    return c.html(publicLayout("What Calantern costs", html`<div class="card"><h1>What Calantern costs</h1>
  <p>Calantern is free for everyone. There are no ads, and we don't sell data.</p>
  <p>Today it runs on the free plans of the services below. As more groups use it, some of these start to cost money: the database, sending email, and the AI that reads forwarded emails.</p>
  <ul>
    <li><strong>Supabase</strong>: database, sign-in and background jobs.</li>
    <li><strong>Cloudflare</strong>: the website and receiving forwarded email.</li>
    <li><strong>Anthropic</strong>: the AI that finds events in emails.</li>
    <li><strong>Resend</strong>: emails Calantern sends you.</li>
  </ul>
  <p>Support is a thank-you, never a paywall. Supporters get a badge on their account and, if they want, their name on the <a href="/supporters">supporters page</a>.</p>
  ${bmc ? html`<p><a class="button" href="${bmc}" rel="noopener">Support Calantern on Buy Me a Coffee</a></p>
  <p class="muted" style="font-size:.875rem">This opens Buy Me a Coffee's site. Calantern never sees your card details.</p>`
    : html`<p class="muted">Donations aren't set up yet.</p>`}
</div>`));
  });

  app.get("/supporters", async (c) => {
    const { data } = await anon(c).rpc("public_supporters");
    const rows = (data ?? []) as { display_name: string; since: string }[];
    return c.html(publicLayout("Supporters", html`<div class="card"><h1>Thank you</h1>
  <p>These people help keep Calantern free. Only supporters who chose to be listed appear here.</p>
  ${rows.length === 0 ? html`<p class="muted">No one has chosen to be listed yet.</p>`
    : html`<ul class="events">${rows.map((r) => html`<li><strong dir="auto">${r.display_name}</strong></li>`)}</ul>`}
  <p><a href="/about/costs">What Calantern costs, and how to help</a></p>
</div>`));
  });

  const render = async (c: Context<AppEnv>, notice?: string, code: 200 | 403 = 200) => {
    const { data } = await c.get("supabase").rpc("my_supporter_status");
    const s = Status.safeParse(data);
    const st = s.success ? s.data : { linked: false, member: false, donations: 0, list_publicly: false, since: null };
    const bmc = bmcUrl(c.env.BMC_USERNAME);
    return c.html(layout("Your support", html`<div class="card"><h1>Your support</h1>
  ${notice ? html`<p role="status">${notice}</p>` : ""}
  ${st.linked
    ? html`<p><strong>Supporter</strong>${st.member ? " · member" : ""}. Thank you for helping keep Calantern free.</p>
  <form method="post" action="/account/support/listing">${csrfField(csrfToken(c))}
    <input type="hidden" name="list" value="${st.list_publicly ? "0" : "1"}">
    <p>${st.list_publicly ? "Your name is on the supporters page." : "Your name is not on the supporters page."}</p>
    <button type="submit" class="secondary">${st.list_publicly ? "Remove my name" : "Show my name on the supporters page"}</button></form>`
    : html`<p>Supported Calantern on Buy Me a Coffee with the same email as this account? Link it to get a supporter badge. Nothing is linked unless you ask.</p>
  <form method="post" action="/account/support/link">${csrfField(csrfToken(c))}<button type="submit">Link my support</button></form>
  ${bmc ? html`<p class="muted">Not a supporter yet? <a href="${bmc}" rel="noopener">Buy Me a Coffee</a>.</p>` : ""}`}
  <p><a href="/account">Back to your account</a></p>
</div>`), code);
  };

  app.get("/account/support", async (c) => {
    if (!(await currentUser(c))) return c.redirect("/login?next=/account/support", 303);
    return render(c);
  });
  app.post("/account/support/link", async (c) => {
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    if (!csrfValid(c, (await form(c)).csrf)) return render(c, MESSAGES.badForm, 403);
    const { data, error } = await c.get("supabase").rpc("link_supporter");
    if (error) return c.html(messagePage("Something went wrong", "Please try again in a minute.", { href: "/account/support", text: "Back" }), 503);
    c.get("log").info("supporter_link", { linked: data === true });
    return render(c, data === true ? "Linked. Thank you!" : "We couldn't find support from this account's email yet. Buy Me a Coffee can take a few minutes to tell us.");
  });
  app.post("/account/support/listing", async (c) => {
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return render(c, MESSAGES.badForm, 403);
    await c.get("supabase").rpc("set_supporter_listing", { p_list: body.list === "1" });
    return render(c, "Saved.");
  });
}
