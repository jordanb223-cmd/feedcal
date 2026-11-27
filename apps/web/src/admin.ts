// Phase 14: trust and safety pages (D35): the admin console (admins only, second factor
// required), "Report this calendar" on public pages, verification, and the policy pages.
import type { Context, Hono } from "hono";
import { seoHead } from "./seo.js";
import { html, raw } from "hono/html";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv } from "./types.js";
import { layout, messagePage, publicLayout } from "./views.js";

const Id = z.uuid();
const AdminStatus = z.object({ is_admin: z.boolean(), aal: z.string() });
const FEED_REPORT_KINDS = { spam: "Spam or advertising", wrong_info: "Wrong or misleading information", inappropriate: "Inappropriate content",
  impersonation: "Pretending to be someone else", privacy: "Shares someone's private information" } as const;

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).filter((e): e is [string, string] => typeof e[1] === "string"));
}
const hidden = (c: Context<AppEnv>) => c.html(messagePage("Not found", "That doesn't exist."), 404);

/** Admins only: everyone else gets a plain 404 (the console doesn't advertise itself). */
async function adminGate(c: Context<AppEnv>): Promise<{ aal2: boolean } | Response> {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login?next=/admin", 303);
  const { data } = await c.get("supabase").rpc("admin_status");
  const s = AdminStatus.safeParse(data);
  if (!s.success || !s.data.is_admin) return hidden(c);
  return { aal2: s.data.aal === "aal2" };
}

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  // ---------------------------------------------------------------- second factor
  app.get("/admin", async (c) => {
    const gate = await adminGate(c);
    if (gate instanceof Response) return gate;
    const sb = c.get("supabase");
    if (!gate.aal2) {
      const { data: factors } = await sb.auth.mfa.listFactors();
      const verified = (factors?.totp ?? []).find((f) => f.status === "verified");
      if (verified) {
        return c.html(layout("Admin sign-in", html`<div class="card"><h1>Second step</h1>
          <p>Enter the 6-digit code from your authenticator app.</p>
          <form method="post" action="/admin/mfa">${raw(`<input type="hidden" name="csrf" value="${csrfToken(c)}">`)}
            <input type="hidden" name="factor" value="${verified.id}">
            <p><label for="code">Code</label><input class="copy" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></p>
            <button type="submit">Continue</button></form></div>`));
      }
      // Not enrolled yet: show the QR code and the secret once.
      const { data: enrolled, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Bumpdraft admin ${new Date().toISOString().slice(0, 10)}` });
      if (error || !enrolled) return c.html(messagePage("Couldn't start set-up", "Please try again in a minute."), 503);
      const qr = String(enrolled.totp.qr_code);
      return c.html(layout("Set up your second factor", html`<div class="card"><h1>Set up your second factor</h1>
        <p>The admin console needs a second step at sign-in. Scan this with an authenticator app (such as 1Password, Google Authenticator or Authy), then enter the code it shows.</p>
        <p style="text-align:center"><img src="${qr.startsWith("data:") ? qr : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`}" alt="QR code for your authenticator app" width="200" height="200"></p>
        <details><summary>Can't scan? Enter this key instead</summary><p><code>${enrolled.totp.secret}</code></p></details>
        <form method="post" action="/admin/mfa">${raw(`<input type="hidden" name="csrf" value="${csrfToken(c)}">`)}
          <input type="hidden" name="factor" value="${enrolled.id}">
          <p><label for="code">Code</label><input class="copy" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></p>
          <button type="submit">Turn on</button></form></div>`));
    }
    const { data: q, error } = await sb.rpc("admin_queue");
    if (error) return hidden(c);
    const queue = q as { reports: { id: string; kind: string; details: string | null; created_at: string; feed: { id: string; name: string; slug: string; hidden: boolean; owner_id: string } }[];
      flags: { id: string; reasons: string[]; excerpt: string | null; created_at: string; feed: { id: string; name: string; slug: string; hidden: boolean; owner_id: string } }[];
      audit: { action: string; target_type: string; reason: string | null; created_at: string }[] };
    const t = csrfToken(c);
    const csrf = raw(`<input type="hidden" name="csrf" value="${t}">`);
    // Phase 18 (D38): spend, budget and alerts.
    const { data: opsData } = await sb.rpc("admin_ops");
    const ops = (opsData ?? null) as { spend: { today_usd: number; month_usd: number; monthly_budget_usd: number; throttled: boolean };
      open_alerts: { kind: string; detail: unknown; opened_at: string; drill: boolean }[] } | null;
    const usd = (n: number) => `$${Number(n).toFixed(2)}`;
    const opsCard = ops ? html`<div class="card"><h2>Operations</h2>
      <p>AI spend today ${usd(ops.spend.today_usd)} · this month ${usd(ops.spend.month_usd)} of ${usd(ops.spend.monthly_budget_usd)}${ops.spend.throttled ? html` · <strong class="error">AI work paused (80% of budget)</strong>` : ""}</p>
      ${ops.open_alerts.length === 0 ? html`<p class="muted">No open alerts.</p>`
        : html`<ul class="events">${ops.open_alerts.map((a) => html`<li><strong>${a.kind}</strong><span class="when">since ${new Date(a.opened_at).toUTCString()} · ${JSON.stringify(a.detail)}</span></li>`)}</ul>`}
      <form method="post" action="/admin/alert-drill">${csrf}<button type="submit" class="secondary">Run the alert drill</button></form>
      <p class="muted" style="font-size:.875rem">The drill fires every alert once (each admin gets the emails, marked as a drill), then clears them.</p></div>` : "";
    const actions = (feed: { id: string; hidden: boolean; owner_id: string }, item: { kind: "report" | "flag"; id: string }) => html`<div class="row" style="margin-top:.5rem">
      ${feed.hidden ? html`<span class="muted">Calendar hidden</span><form method="post" action="/admin/feeds/${feed.id}/unhide">${csrf}<input type="hidden" name="reason" value="${item.kind}:${item.id}"><button type="submit" class="secondary">Show it again</button></form>` : html`<form method="post" action="/admin/feeds/${feed.id}/hide">${csrf}<input type="hidden" name="reason" value="${item.kind}:${item.id}"><button type="submit" class="danger">Hide calendar</button></form>`}
      <form method="post" action="/admin/${item.kind}s/${item.id}/dismiss">${csrf}<button type="submit" class="secondary">Dismiss</button></form>
      <form method="post" action="/admin/users/${feed.owner_id}/suspend">${csrf}<input type="hidden" name="reason" value="${item.kind}:${item.id}"><button type="submit" class="secondary">Suspend owner</button></form>
    </div>`;
    return c.html(layout("Admin", html`<div class="card"><h1>Admin queue</h1>
      <p>${queue.reports.length} reports · ${queue.flags.length} flags</p></div>
      ${queue.reports.map((r) => html`<div class="card"><h2 dir="auto">${r.feed.name}</h2>
        <p><strong>${FEED_REPORT_KINDS[r.kind as keyof typeof FEED_REPORT_KINDS] ?? r.kind}</strong> · ${new Date(r.created_at).toUTCString()}</p>
        ${r.details ? html`<blockquote class="muted" dir="auto">${r.details}</blockquote>` : ""}
        <p><a href="/c/${r.feed.slug}" target="_blank" rel="noopener">Open the public page</a></p>
        ${actions(r.feed, { kind: "report", id: r.id })}</div>`)}
      ${queue.flags.map((f) => html`<div class="card"><h2 dir="auto">${f.feed.name}</h2>
        <p><strong>Automatic flag:</strong> ${f.reasons.join(", ")}</p>
        ${f.excerpt ? html`<blockquote class="muted" dir="auto">${f.excerpt}</blockquote>` : ""}
        ${actions(f.feed, { kind: "flag", id: f.id })}</div>`)}
      ${opsCard}
      <div class="card"><h2>Audit log</h2>${queue.audit.length === 0 ? html`<p class="muted">No admin actions yet.</p>` : ""}<ul class="events">${queue.audit.map((a) => html`<li>${a.action} (${a.target_type})<span class="when">${new Date(a.created_at).toUTCString()}${a.reason ? ` · ${a.reason}` : ""}</span></li>`)}</ul></div>`));
  });

  app.post("/admin/mfa", async (c) => {
    const gate = await adminGate(c);
    if (gate instanceof Response) return gate;
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/admin", text: "Back" }), 403);
    const factor = Id.safeParse(body.factor);
    const code = z.string().regex(/^\d{6}$/).safeParse(body.code);
    if (!factor.success || !code.success) return c.html(messagePage("Check the code", "Please enter the 6-digit code.", { href: "/admin", text: "Back" }), 400);
    const sb = c.get("supabase");
    const { data: challenge, error } = await sb.auth.mfa.challenge({ factorId: factor.data });
    if (error || !challenge) return c.html(messagePage("Please try again", "We couldn't start the check. Try again.", { href: "/admin", text: "Back" }), 400);
    const { error: verifyError } = await sb.auth.mfa.verify({ factorId: factor.data, challengeId: challenge.id, code: code.data });
    if (verifyError) {
      c.get("log").warn("admin_mfa_failed");
      return c.html(messagePage("That code didn't work", "Codes change every 30 seconds. Please try the current one.", { href: "/admin", text: "Try again" }), 400);
    }
    c.get("log").info("admin_mfa_ok");
    return c.redirect("/admin", 303);
  });

  // ---------------------------------------------------------------- one-click actions (audited in the database)
  const adminAction = (path: string, run: (c: Context<AppEnv>, id: string, f: Record<string, string>) => PromiseLike<{ error: unknown }>) => {
    app.post(path, async (c) => {
      const gate = await adminGate(c);
      if (gate instanceof Response) return gate;
      const id = Id.safeParse(c.req.param("id"));
      if (!id.success) return hidden(c);
      const body = await form(c);
      if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/admin", text: "Back" }), 403);
      const { error } = await run(c, id.data, body);
      if (error) return c.html(messagePage("Not done", "That action needs a second factor, or the item no longer exists.", { href: "/admin", text: "Back" }), 403);
      return c.redirect("/admin", 303);
    });
  };
  adminAction("/admin/feeds/:id/hide", (c, id, f) => c.get("supabase").rpc("admin_hide_feed", { p_feed_id: id, p_reason: (f.reason ?? "").slice(0, 500) }));
  adminAction("/admin/feeds/:id/unhide", (c, id, f) => c.get("supabase").rpc("admin_unhide_feed", { p_feed_id: id, p_reason: (f.reason ?? "").slice(0, 500) }));
  adminAction("/admin/reports/:id/dismiss", (c, id) => c.get("supabase").rpc("admin_dismiss", { p_kind: "report", p_id: id }));
  adminAction("/admin/flags/:id/dismiss", (c, id) => c.get("supabase").rpc("admin_dismiss", { p_kind: "flag", p_id: id }));
  adminAction("/admin/users/:id/suspend", (c, id, f) => c.get("supabase").rpc("admin_suspend_user", { p_user_id: id, p_reason: (f.reason ?? "").slice(0, 500) }));

  app.post("/admin/alert-drill", async (c) => {
    const gate = await adminGate(c);
    if (gate instanceof Response) return gate;
    if (!csrfValid(c, (await form(c)).csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: "/admin", text: "Back" }), 403);
    const { data, error } = await c.get("supabase").rpc("admin_alert_drill");
    if (error) return c.html(messagePage("Not done", "The drill needs a second factor.", { href: "/admin", text: "Back" }), 403);
    c.get("log").info("alert_drill", { opened: JSON.stringify((data as { opened?: unknown } | null)?.opened ?? []) });
    return c.html(messagePage("Drill sent", "Every alert fired once. Check your inbox for the drill emails.", { href: "/admin", text: "Back to the console" }));
  });

  // ---------------------------------------------------------------- "Report this calendar" (public pages)
  const Slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/);
  const reportForm = (c: Context<AppEnv>, slug: string, error?: string) => publicLayout("Report this calendar", html`<div class="card"><h1>Report this calendar</h1>
    <p>Reports go to Bumpdraft's team, not the calendar's organizer. We don't ask for your name.</p>
    ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
    <form method="post" action="/c/${slug}/report">${raw(`<input type="hidden" name="csrf" value="${csrfToken(c)}">`)}
      <fieldset style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600">What's the problem?</legend>
        ${Object.entries(FEED_REPORT_KINDS).map(([k, v], i) => html`<label class="check"><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""}> ${v}</label>`)}</fieldset>
      <p><label for="details">Details (optional)</label><textarea id="details" name="details" rows="3" maxlength="2000" dir="auto"></textarea></p>
      <button type="submit">Send report</button></form>
    <p class="muted">See our <a href="/rules">community rules</a> and <a href="/takedown">takedown process</a>.</p></div>`);
  app.get("/c/:slug/report", (c) => {
    const slug = Slug.safeParse(c.req.param("slug"));
    if (!slug.success) return hidden(c);
    c.header("x-robots-tag", "noindex");
    return c.html(reportForm(c, slug.data));
  });
  app.post("/c/:slug/report", async (c) => {
    const slug = Slug.safeParse(c.req.param("slug"));
    if (!slug.success) return hidden(c);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(reportForm(c, slug.data, MESSAGES.badForm), 403);
    const kind = z.enum(Object.keys(FEED_REPORT_KINDS) as [keyof typeof FEED_REPORT_KINDS]).safeParse(body.kind);
    if (!kind.success) return c.html(reportForm(c, slug.data, "Please choose what's wrong."), 400);
    const ip = c.req.header("cf-connecting-ip");
    const { data } = await c.get("supabase").rpc("submit_feed_report", { p_slug: slug.data, p_kind: kind.data, ...(body.details ? { p_details: body.details.slice(0, 2000) } : {}), ...(ip ? { p_client_ip: ip } : {}) });
    if (data === "rate_limited") return c.html(messagePage("Please wait", "Too many reports were sent from here recently. Please try again in an hour."), 429);
    if (data !== "ok") return hidden(c);
    return c.html(messagePage("Thank you", "Your report was sent to Bumpdraft's team. We aim to look at it within 2 business days (sooner for safety issues)."));
  });

  // ---------------------------------------------------------------- verification
  app.post("/feeds/:id/verify", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return hidden(c);
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/settings`, text: "Back" }), 403);
    const { data, error } = await c.get("supabase").rpc("verify_feed_by_domain", { p_feed_id: id.data });
    if (error) return c.html(messagePage("Not allowed", "Only the owner can ask for verification."), 403);
    return c.html(data === true
      ? messagePage("Verified", "Your calendar now shows a verified badge: your email address is at the same organisation that sends its emails.", { href: `/feeds/${id.data}/settings`, text: "Back to settings" })
      : messagePage("Not verified automatically", "We verify automatically when you sign in with your organisation's email (not Gmail, Yahoo and so on) and that organisation's address is a trusted sender for this calendar. Otherwise, reply to any Bumpdraft email and we'll check by hand.", { href: `/feeds/${id.data}/settings`, text: "Back to settings" }));
  });
}

// ---------------------------------------------------------------- policy pages (drafts)
const DRAFT = html`<p class="muted"><strong>Draft.</strong> To be reviewed by a lawyer before public launch (see BUILD-PLAN "Non-negotiables").</p>`;
export function registerPolicyRoutes(app: Hono<AppEnv>): void {
  app.get("/rules", (c) => c.html(publicLayout("Community rules", html`<div class="card"><h1>Community rules</h1>${DRAFT}
    <p>Bumpdraft calendars are for real events from real groups. To keep it useful and safe:</p>
    <ul>
      <li>Only share events you have the right to share: your own group's, or ones you were sent to pass on.</li>
      <li>Don't pretend to be a school, team or person you aren't.</li>
      <li>No spam, advertising for unrelated products, or hateful, violent or sexual content.</li>
      <li>Keep children safe: no children's full names, home addresses, phone numbers or photos in public calendars. School and youth calendars start as "anyone with the link" for this reason.</li>
      <li>Keep events accurate. If plans change, update or cancel them.</li>
      <li>The same rules apply in event chats and in questions to organizers. No harassment, no private details about other people, no links.</li>
      <li>Bumpdraft is for adults. Don't let children post.</li>
    </ul>
    <p>Breaking these rules can get a calendar hidden or an account suspended. <a href="/takedown">How reports and takedowns work</a>.</p></div>`, seoHead(c, "Community rules", "How Bumpdraft calendars stay useful and safe: what can be shared, and what isn't allowed."))));
  app.get("/terms", (c) => c.html(publicLayout("Terms of use", html`<div class="card"><h1>Terms of use</h1>${DRAFT}
    <p>Bumpdraft is a free service that turns forwarded emails into calendars people can subscribe to.</p>
    <ul>
      <li><strong>Who can use Bumpdraft.</strong> You must be 18 or older to create an account, post in a chat, or send a question. Bumpdraft is for parents, organizers and other adults. It is not for children to use.</li>
      <li><strong>Your content.</strong> You keep the rights to what you send. You let Bumpdraft store and process it to run your calendars, and publish what you choose to publish.</li>
      <li><strong>Your responsibilities.</strong> Follow the <a href="/rules">community rules</a>. Check what Bumpdraft publishes for you; it uses AI and can make mistakes.</li>
      <li><strong>What the AI does.</strong> Bumpdraft reads the emails you send it and writes calendar events from them. It can get dates, times and places wrong. Events on your calendars are published under your account, and you are responsible for checking them.</li>
      <li><strong>Copyright.</strong> Only send Bumpdraft material you have the right to share. We remove material when we get a valid copyright notice (see <a href="/takedown#copyright">Reports and takedowns</a>). We close the accounts of people who repeatedly infringe copyright.</li>
      <li><strong>No guarantees.</strong> Bumpdraft is provided as is. Don't rely on it for anything where a missed or wrong event would cause harm.</li>
      <li><strong>Ending.</strong> You can delete your account at any time from your account page. We may hide calendars or suspend accounts that break the rules.</li>
      <li><strong>Email.</strong> Forwarded emails and attachments are deleted after 30 days.</li>
      <li><strong>Changes to these terms.</strong> If we change these terms in a way that matters, we'll email account holders at least 14 days before the change takes effect. If you keep using Bumpdraft after that date, you accept the new terms.</li>
    </ul></div>`, seoHead(c, "Terms of use", "The terms for using Bumpdraft, the free service that turns emails into calendars people can subscribe to."))));
  app.get("/takedown", (c) => c.html(publicLayout("Reports and takedowns", html`<div class="card"><h1>Reports and takedowns</h1>${DRAFT}
    <p>Anyone can report a calendar with the "Report this calendar" link on its page, or report one event from the link inside it in their calendar.</p>
    <ul>
      <li><strong>Safety issues</strong> (a child's private information, threats): we aim to act within 1 business day, usually by hiding the calendar while we look.</li>
      <li><strong>Impersonation, spam, wrong information</strong>: we aim to respond within 2 business days.</li>
      <li><strong>Copyright</strong>: see below.</li>
      <li><strong>Other legal requests</strong>: send the details through the <a href="/contact">contact form</a>; we aim to respond within 5 business days.</li>
    </ul>
    <p>Hidden calendars stop updating subscribers at once. Organizers are told what happened and can ask for another look.</p>
    <h2 id="copyright">Copyright</h2>
    <p>If you believe something on Bumpdraft copies your work without permission, send a notice through the <a href="/contact">contact form</a>. Your notice must include:</p>
    <ul>
      <li>Your signature, typed or handwritten.</li>
      <li>What work of yours was copied.</li>
      <li>Where it is on Bumpdraft: the calendar's link and the event's name and date.</li>
      <li>How to reach you: an address, phone number, or email address.</li>
      <li>A statement that you believe in good faith the use is not allowed by the copyright owner, its agent, or the law.</li>
      <li>A statement that the notice is accurate and, under penalty of perjury, that you are the owner or are allowed to act for the owner.</li>
    </ul>
    <p>We remove or hide the material promptly after a complete notice, and tell the organizer who posted it.</p>
    <p><strong>If your material was removed by mistake,</strong> send a counter-notice the same way, with:</p>
    <ul>
      <li>Your signature.</li>
      <li>What was removed and where it was.</li>
      <li>A statement, under penalty of perjury, that you believe in good faith it was removed by mistake or misidentification.</li>
      <li>Your name, address and phone number, and a statement that you accept the jurisdiction of the federal district court where you live (or, outside the United States, any district where Bumpdraft can be found), and that you will accept service of process from the person who sent the notice.</li>
    </ul>
    <p>We send your counter-notice to the person who complained. Unless they tell us they have filed a court action, we put the material back 10 to 14 business days after we receive your counter-notice.</p>
    <p><strong>Repeat infringers.</strong> We close the accounts of people who repeatedly infringe copyright.</p></div>`, seoHead(c, "Reports and takedowns", "How to report a calendar or an event on Bumpdraft, and how takedown requests are handled."))));
}
