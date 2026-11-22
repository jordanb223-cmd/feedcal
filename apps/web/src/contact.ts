// D63: the contact and bug-report form. Messages go to the admins by email and are kept 90 days.
// Spam: a hidden field people never fill in, 5 messages an hour per address (in SQL), size limits.
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { csrfToken, csrfValid, originOf } from "./security.js";
import type { AppEnv } from "./types.js";
import { publicLayout } from "./views.js";

const KINDS = [["bug", "Something isn't working"], ["question", "A question"], ["privacy", "A privacy or data request"], ["other", "Something else"]] as const;
type Form = { kind?: string; message?: string; reply_to?: string; page?: string; error?: string };

/** The page someone came from, if it was a Calantern page: the path only. */
function fromPage(c: Context<AppEnv>, value: string | undefined): string {
  if (!value) return "";
  try {
    const u = new URL(value, originOf(c));
    return u.origin === originOf(c) && !u.pathname.startsWith("/contact") ? u.pathname.slice(0, 300) : "";
  } catch {
    return "";
  }
}

function contactForm(c: Context<AppEnv>, f: Form) {
  return publicLayout("Contact", html`<div class="card">
  <h1>Contact Calantern</h1>
  <p>Found a bug, have a question, or want to ask about your data? Send a message. If you'd like an answer, add your email address.</p>
  ${f.error ? html`<p class="notice" role="alert">${f.error}</p>` : ""}
  <form method="post" action="/contact">
    <input type="hidden" name="csrf" value="${csrfToken(c)}">
    <input type="hidden" name="page" value="${f.page ?? ""}">
    <p><label for="kind">What is it about?</label><select class="copy" id="kind" name="kind">${KINDS.map(([v, label]) => html`<option value="${v}" ${f.kind === v ? "selected" : ""}>${label}</option>`)}</select></p>
    <p><label for="message">Message</label><textarea class="copy" id="message" name="message" rows="6" maxlength="4000" required>${f.message ?? ""}</textarea></p>
    <p><label for="reply_to">Your email <span class="muted">(optional, only if you'd like a reply)</span></label><input class="copy" id="reply_to" name="reply_to" type="email" autocomplete="email" maxlength="254" value="${f.reply_to ?? ""}"></p>
    <p aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></p>
    <p class="muted" style="font-size:.875rem">Please don't include passwords or sensitive personal details. Messages are kept for 90 days. <a href="/privacy">Privacy</a></p>
    <button type="submit">Send</button>
  </form>
</div>`, html`<meta name="robots" content="noindex">`);
}

export function registerContactRoutes(app: Hono<AppEnv>): void {
  app.get("/contact", (c) => c.html(contactForm(c, { page: fromPage(c, c.req.query("from") ?? c.req.header("referer")) })));

  app.post("/contact", async (c) => {
    const b = await c.req.parseBody();
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    const f: Form = { kind: s("kind"), message: s("message").slice(0, 4000), reply_to: s("reply_to").trim().slice(0, 254), page: fromPage(c, s("page")) };
    if (!csrfValid(c, b.csrf)) return c.html(contactForm(c, { ...f, error: "Please try sending again." }), 403);
    const thanks = () => c.html(publicLayout("Message sent", html`<div class="card"><h1>Thanks, your message was sent</h1>
      <p>${f.reply_to ? "We'll reply to the address you gave." : "You didn't add an email address, so we can't reply, but we'll read it."}</p><p><a href="/">Back to Calantern</a></p></div>`));
    if (s("website")) return thanks(); // the hidden field: only bots fill it in
    if (!f.message?.trim()) return c.html(contactForm(c, { ...f, error: "Please write a message." }), 400);
    const ip = c.req.header("cf-connecting-ip");
    const { data, error } = await c.get("supabase").rpc("submit_contact", {
      p_kind: f.kind ?? "", p_message: f.message, ...(f.reply_to ? { p_reply_to: f.reply_to } : {}), ...(f.page ? { p_page: f.page } : {}), ...(ip ? { p_client_ip: ip } : {}),
    });
    if (error) return c.html(contactForm(c, { ...f, error: "Something went wrong on our side. Please try again in a minute." }), 503);
    if (data === "too_many") return c.html(contactForm(c, { ...f, error: "You've sent several messages in the last hour. Please try again later." }), 429);
    if (data === "bad_email") return c.html(contactForm(c, { ...f, error: "That email address doesn't look right. Fix it, or leave it empty." }), 400);
    if (data !== "ok") return c.html(contactForm(c, { ...f, error: "Please choose a topic and write a message." }), 400);
    c.get("log").info("contact_sent", { kind: f.kind });  // never the message or address
    return thanks();
  });
}
