// Phase 17 (D39): the Gmail page of a feed, as designed with the owner:
// Connect → search for an example → pick it → confirm what Feedcal will do → status.
// The web app never sees a Google token: Edge Functions hold them. Owner only (checked in SQL).
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { feedNav } from "./nav.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv } from "./types.js";
import { layout, messagePage } from "./views.js";
import { importForm } from "./imports.js";

const FeedId = z.uuid();
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const Candidate = z.object({ id: z.string(), from_email: z.string(), from_name: z.string(), subject: z.string(), date: z.string() });
const Status = z.object({
  connected: z.boolean(),
  status: z.enum(["choose_example", "active", "needs_reconnect"]).optional(),
  google_email: z.string().nullable().optional(),
  candidates: z.array(Candidate).optional(),
  sender_email: z.string().nullable().optional(),
  sender_name: z.string().nullable().optional(),
  interval_days: z.number().optional(),
  last_checked_at: z.string().nullable().optional(),
  next_check_at: z.string().nullable().optional(),
  reconnect_by: z.string().nullable().optional(),
  messages_ingested: z.number().optional(),
  last_error: z.string().nullable().optional(),
});
type Status = z.infer<typeof Status>;
type Cand = z.infer<typeof Candidate>;

const RESULTS: Record<string, string> = {
  connected: "Gmail is connected. Now find an example email.",
  confirmed: "Done. Feedcal will read your example now, then check on your schedule.",
  cancelled: "Connecting was cancelled. Nothing was changed.",
  not_granted: "Google didn't give Feedcal permission to read email, so nothing was connected. Try again and allow it.",
  expired: "That took too long. Please connect again.",
  failed: "Something went wrong connecting Gmail. Please try again.",
  interval: "Schedule saved.",
  look_back: "Feedcal will now read emails from this sender from the last 30 days, 3 at a time every 5 minutes, until it's caught up.",
  look_back_failed: "That didn't work. Gmail needs to be connected and a sender picked first.",
};

const csrfField = (t: string) => html`<input type="hidden" name="csrf" value="${t}">`;
const day = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(iso)) : "—";

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).filter((e): e is [string, string] => typeof e[1] === "string"));
}

async function load(c: Context<AppEnv>, id: string): Promise<{ name: string; status: Status } | null> {
  const sb = c.get("supabase");
  const { data: feed } = await sb.from("feeds").select("name").eq("id", id).maybeSingle();
  const { data, error } = await sb.rpc("gmail_status", { p_feed_id: id });
  if (!feed || error) return null;
  const s = Status.safeParse(data);
  return s.success ? { name: (feed as { name: string }).name, status: s.data } : null;
}

function page(c: Context<AppEnv>, id: string, name: string, s: Status, opts: { notice?: string; error?: string; candidates?: Cand[] } = {}) {
  const t = csrfToken(c);
  const enabled = Boolean(c.env.GMAIL_CLIENT_ID);
  const head = html`${feedNav(id, "gmail")}<h1>Gmail for <span dir="auto">${name}</span></h1>
    ${opts.notice ? html`<p role="status">${opts.notice}</p>` : ""}${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}`;
  const disconnect = html`<form method="post" action="/feeds/${id}/gmail/disconnect">${csrfField(t)}
    <p><label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand this deletes Feedcal's copies of these emails</label></p>
    <button type="submit" class="danger">Disconnect Gmail</button></form>
    <p class="muted" style="font-size:.875rem">Disconnecting deletes Feedcal's access and every copy of the emails it read from Gmail, right away.</p>`;

  if (!s.connected) {
    return layout(`Gmail for ${name}`, html`<div class="card">${head}
      <p>Instead of forwarding, Feedcal can check your Gmail for <strong>one sender</strong>, like your school or coach, and add their events to this calendar.</p>
      <ul>
        <li>You show Feedcal one example email. It only ever looks for emails <strong>from that sender</strong>.</li>
        <li>It checks every 3 or 7 days, your choice.</li>
        <li>It can't send, delete or change anything in your Gmail (read-only).</li>
      </ul>
      ${enabled
        ? html`<form method="post" action="/feeds/${id}/gmail/connect">${csrfField(t)}<button type="submit">Connect Gmail</button></form>
          <p class="muted" style="font-size:.875rem">Google will say Feedcal is in testing and ask you to allow reading email. While Feedcal is in Google's test mode, you'll be asked to reconnect once a week; we'll email you a reminder.</p>`
        : html`<p class="muted">Gmail connection isn't switched on for this site yet.</p>`}
    </div>`);
  }

  if (s.status === "needs_reconnect") {
    return layout(`Gmail for ${name}`, html`<div class="card">${head}
      <p class="error" role="alert">Google ended Feedcal's connection to ${s.google_email ?? "your Gmail"}. New emails from ${s.sender_email ?? "your sender"} won't arrive until you reconnect.</p>
      <form method="post" action="/feeds/${id}/gmail/connect">${csrfField(t)}<button type="submit">Reconnect Gmail</button></form>
      <p class="muted">Your sender and schedule are kept.</p></div><div class="card">${disconnect}</div>`);
  }

  if (s.status === "choose_example" || opts.candidates) {
    const cands = opts.candidates ?? s.candidates ?? [];
    return layout(`Gmail for ${name}`, html`<div class="card">${head}
      <h2>Step 1: find an example email</h2>
      <p>Search for one email with the calendar details, like the school's name. Feedcal looks back 30 days and shows sender, subject and date only.</p>
      <form method="post" action="/feeds/${id}/gmail/search">${csrfField(t)}
        <p><label for="words">Search for</label><input class="copy" id="words" name="words" required minlength="2" maxlength="100" autocomplete="off" placeholder="e.g. Room F newsletter"></p>
        <button type="submit">Search</button></form>
    </div>
    ${cands.length > 0 ? html`<div class="card"><h2>Step 2: pick the email with the calendar information</h2>
      <form method="post" action="/feeds/${id}/gmail/review">${csrfField(t)}
        ${cands.map((x, i) => html`<p><label class="check"><input type="radio" name="gmail_id" value="${x.id}" ${i === 0 ? "checked" : ""} ${x.from_email ? "" : "disabled"}>
          <span><strong dir="auto">${x.subject || "(no subject)"}</strong><br><span class="muted" dir="auto">${x.from_name ? `${x.from_name} · ` : ""}${x.from_email || "no sender address, can't be used"} · ${day(x.date)}</span></span></label></p>`)}
        <details class="more"><summary>Checks every 7 days · also reads the 30 days before your example · Change</summary>
          <p><label for="interval">How often should Feedcal check for new emails from this sender?</label>
            <select class="copy" id="interval" name="interval"><option value="7" selected>Every 7 days</option><option value="3">Every 3 days</option></select></p>
          <p><label class="check"><input type="checkbox" name="look_back" value="1" checked>
            <span>Also read earlier emails from this sender, from the 30 days before your example</span></label></p>
        </details>
        <button type="submit" class="wide">Next</button></form></div>`
      : opts.candidates ? html`<div class="card"><p class="muted">No emails matched. Try different words.</p></div>` : ""}
    <details class="more card"><summary>Wrong Gmail account?</summary>${disconnect}</details>`);
  }

  return layout(`Gmail for ${name}`, html`<div class="card">${head}
    <p>Feedcal checks <strong>${s.google_email ?? "your Gmail"}</strong> for emails <strong>from ${s.sender_name ? `${s.sender_name} ` : ""}&lt;${s.sender_email}&gt;</strong> only.</p>
    <ul class="events">
      <li>How often<span class="when">every ${s.interval_days} days</span></li>
      <li>Last checked<span class="when">${day(s.last_checked_at)}</span></li>
      <li>Next check<span class="when">${day(s.next_check_at)}</span></li>
      <li>Emails read so far<span class="when">${s.messages_ingested ?? 0}</span></li>
      <li>Reconnect by<span class="when">${day(s.reconnect_by)} (Google's test-mode limit; we'll remind you)</span></li>
    </ul>
    <form method="post" action="/feeds/${id}/gmail/interval" class="row">${csrfField(t)}
      <label for="interval">Check</label>
      <select id="interval" name="interval"><option value="7" ${s.interval_days === 7 ? "selected" : ""}>every 7 days</option><option value="3" ${s.interval_days === 3 ? "selected" : ""}>every 3 days</option></select>
      <button type="submit" class="secondary">Save</button></form>
    <form method="post" action="/feeds/${id}/gmail/look-back">${csrfField(t)}
      <button type="submit" class="secondary">Read the last 30 days</button></form>
    <p class="muted" style="font-size:.875rem">Reads earlier emails from this sender only, back 30 days, 3 every 5 minutes. Emails already read are skipped.</p>
    <p class="muted">New emails go through the same steps as forwarded ones: the first email from a new sender waits for your OK on the <a href="/feeds/${id}/email">Email page</a>.</p>
  </div><div class="card">${disconnect}</div>`);
}

export function registerGmailRoutes(app: Hono<AppEnv>): void {
  const owner = async (c: Context<AppEnv>) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return { res: c.html(messagePage("Feed not found", "That feed doesn't exist."), 404) };
    if (!(await currentUser(c))) return { res: c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/gmail`)}`, 303) };
    const loaded = await load(c, id.data);
    if (!loaded) return { res: c.html(messagePage("Only the owner can do this", "Only the feed's owner can connect Gmail."), 403) };
    return { id: id.data, ...loaded };
  };

  // D47: right after a calendar is made, the one question that matters.
  app.get("/feeds/:id/setup", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const t = csrfToken(c);
    const gmailOn = Boolean(c.env.GMAIL_CLIENT_ID);
    const later = c.req.query("public_later") === "1";
    return c.html(layout(`Set up ${o.name}`, html`<div class="card">
      <span class="kicker">New calendar</span>
      <h1>Where do <span dir="auto">${o.name}</span>'s emails come from?</h1>
      ${later ? html`<p class="muted">It starts Private. You can make it Public in Settings once it has an event.</p>` : ""}
      ${gmailOn ? html`<div class="pick">
        <h2>Connect Gmail <span class="tag">Easiest</span></h2>
        <p class="muted">Pick one example email. Feedcal reads only that sender, read-only, and keeps the calendar up to date.</p>
        <form method="post" action="/feeds/${o.id}/gmail/connect">${csrfField(t)}<button type="submit" class="wide">Connect Gmail</button></form>
      </div>` : ""}
      <div class="pick">
        <h2>Forward emails</h2>
        <p class="muted">Works with any email app. Feedcal gives this calendar its own address to forward to.</p>
        <a class="button ${gmailOn ? "secondary " : ""}wide" href="/feeds/${o.id}/email?done=created">Get the forwarding address</a>
      </div>
      <details class="more"><summary>More ways to add events</summary>
        <p><a href="/feeds/${o.id}/events/new">Add events by hand</a></p>
        <h3 style="margin:1rem 0 .25rem;font-size:1rem">Copy events from a calendar link</h3>
        <p class="muted" style="font-size:.875rem">Already have a school or team calendar link? Feedcal copies its events into this calendar, alongside the ones from email.</p>
        ${importForm(o.id, t, "setup")}
      </details>
    </div>`));
  });

  app.get("/feeds/:id/gmail", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const r = c.req.query("result");
    return c.html(page(c, o.id, o.name, o.status, r && RESULTS[r] ? { notice: RESULTS[r] } : {}));
  });

  app.post("/feeds/:id/gmail/connect", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    if (!csrfValid(c, (await form(c)).csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    const clientId = c.env.GMAIL_CLIENT_ID;
    if (!clientId) return c.html(page(c, o.id, o.name, o.status, { error: "Gmail connection isn't switched on for this site yet." }), 400);
    const { data, error } = await c.get("supabase").rpc("gmail_start", { p_feed_id: o.id });
    const s = data as { state?: string; code_challenge?: string } | null;
    if (error || !s?.state || !s.code_challenge) return c.html(page(c, o.id, o.name, o.status, { error: RESULTS.failed ?? "Something went wrong." }), 503);
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: `${c.env.SUPABASE_URL}/functions/v1/gmail-oauth`, response_type: "code", scope: GMAIL_SCOPE,
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: s.state, code_challenge: s.code_challenge, code_challenge_method: "S256",
    });
    c.get("log").info("gmail_connect_started");
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 303);
  });

  app.post("/feeds/:id/gmail/search", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    const words = (body.words ?? "").trim();
    if (words.length < 2) return c.html(page(c, o.id, o.name, o.status, { error: "Type at least two letters." }), 400);
    const { data, error } = await c.get("supabase").functions.invoke("gmail-search", { body: { feed_id: o.id, words } });
    const parsed = z.object({ candidates: z.array(Candidate) }).safeParse(data);
    if (error || !parsed.success) {
      const again = await load(c, o.id);
      return c.html(page(c, o.id, o.name, again?.status ?? o.status, { error: "The search didn't work. If Gmail asks you to reconnect, do that first; otherwise try again." }), 502);
    }
    c.get("log").info("gmail_example_search", { results: parsed.data.candidates.length });
    return c.html(page(c, o.id, o.name, o.status, { candidates: parsed.data.candidates }));
  });

  // The confirmation the owner asked for: say plainly what Feedcal will do before saving anything.
  app.post("/feeds/:id/gmail/review", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    const pick = (o.status.candidates ?? []).find((x) => x.id === body.gmail_id && x.from_email);
    const interval = body.interval === "3" ? 3 : 7;
    const lookBack = body.look_back === "1";
    if (!pick) return c.html(page(c, o.id, o.name, o.status, { error: "Pick one of the emails first." }), 400);
    const t = csrfToken(c);
    return c.html(layout(`Gmail for ${o.name}`, html`<div class="card">${feedNav(o.id, "gmail")}
      <h1>Here's what Feedcal will do for <span dir="auto">${o.name}</span></h1>
      <ul>
        <li>Look <strong>only</strong> for emails <strong>from ${pick.from_name ? `${pick.from_name} ` : ""}&lt;${pick.from_email}&gt;</strong>. Nothing else in your Gmail is searched or read.</li>
        <li>Check <strong>every ${interval} days</strong>.</li>
        <li>Read your example now ("<span dir="auto">${pick.subject || "(no subject)"}</span>", ${day(pick.date)}), then each new email from that sender, and add their events to ${o.name}'s calendar.</li>
        ${lookBack ? html`<li>Also read earlier emails from that sender, from the 30 days before your example, 3 every 5 minutes until caught up.</li>` : ""}
        <li>You can change this or disconnect at any time. Disconnecting deletes Feedcal's copies.</li>
      </ul>
      <form method="post" action="/feeds/${o.id}/gmail/confirm" class="row">${csrfField(t)}
        <input type="hidden" name="gmail_id" value="${pick.id}"><input type="hidden" name="interval" value="${interval}">${lookBack ? html`<input type="hidden" name="look_back" value="1">` : ""}
        <button type="submit">Confirm</button> <a class="button secondary" href="/feeds/${o.id}/gmail">Pick a different email</a>
      </form></div>`));
  });

  app.post("/feeds/:id/gmail/confirm", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    const { data, error } = await c.get("supabase").rpc("gmail_choose_example", { p_feed_id: o.id, p_gmail_id: body.gmail_id ?? "", p_interval_days: body.interval === "3" ? 3 : 7, p_look_back: body.look_back === "1" });
    if (error || data !== true) return c.html(page(c, o.id, o.name, o.status, { error: "That email isn't in your latest search any more. Search again." }), 400);
    c.get("log").info("gmail_example_confirmed");
    return c.redirect(`/feeds/${o.id}/share?ready=gmail`, 303);
  });

  app.post("/feeds/:id/gmail/interval", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    await c.get("supabase").rpc("gmail_set_interval", { p_feed_id: o.id, p_interval_days: body.interval === "3" ? 3 : 7 });
    return c.redirect(`/feeds/${o.id}/gmail?result=interval`, 303);
  });

  app.post("/feeds/:id/gmail/look-back", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    if (!csrfValid(c, (await form(c)).csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    const { data, error } = await c.get("supabase").rpc("gmail_look_back", { p_feed_id: o.id });
    c.get("log").info("gmail_look_back", { ok: !error && data === true });
    return c.redirect(`/feeds/${o.id}/gmail?result=${!error && data === true ? "look_back" : "look_back_failed"}`, 303);
  });

  app.post("/feeds/:id/gmail/disconnect", async (c) => {
    const o = await owner(c);
    if ("res" in o) return o.res;
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(page(c, o.id, o.name, o.status, { error: MESSAGES.badForm }), 403);
    if (body.confirm !== "yes") return c.html(page(c, o.id, o.name, o.status, { error: "Tick the box to confirm, then press Disconnect Gmail again. Nothing was changed." }), 400);
    // D51: revoke with Google first (form body, via the Edge Function), then delete. Best effort.
    const { data: rev } = await c.get("supabase").functions.invoke("gmail-revoke", { body: { feed_id: o.id } }).catch(() => ({ data: null }));
    c.get("log").info("gmail_revoke", { revoked: Boolean((rev as { revoked?: boolean } | null)?.revoked) });
    const { data } = await c.get("supabase").rpc("gmail_disconnect", { p_feed_id: o.id });
    const n = Number((data as { messages_deleted?: number } | null)?.messages_deleted ?? 0);
    c.get("log").info("gmail_disconnected", { messages_deleted: n });
    return c.html(messagePage("Gmail disconnected", `Feedcal's access is removed, and ${n} ${n === 1 ? "email copy was" : "email copies were"} deleted.`, { href: `/feeds/${o.id}`, text: `Back to ${o.name}` }));
  });
}
