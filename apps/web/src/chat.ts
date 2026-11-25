// D89: a chat on one event, switched on by its organizer. Followers post without a name; the
// database gives each a made-up one, refuses links, limits how fast anyone posts, and closes the
// chat when the event is over. This file is the pages: read, post, report, remove.
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { z } from "zod";
import { MESSAGES } from "./auth.js";
import { csrfToken, csrfValid } from "./security.js";
import { formatWhen } from "./subscribe-views.js";
import type { AppEnv } from "./types.js";
import { messagePage, publicLayout } from "./views.js";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
const Uid = z.string().regex(/^[0-9a-f-]{36}@feedcal\.app$/);
const Mid = z.uuid();
const ChatPage = z.object({
  event: z.object({ title: z.string().nullable(), calendar: z.string().nullable(), starts_at: z.string(), ends_at: z.string().nullable(), all_day: z.boolean(), timezone: z.string() }),
  open: z.boolean(), on: z.boolean(), moderator: z.boolean(),
  messages: z.array(z.object({ id: z.uuid(), name: z.string(), body: z.string(), at: z.string(), organizer: z.boolean() })).max(100),
});
export type ChatPage = z.infer<typeof ChatPage>;

const REFUSED: Record<string, string> = {
  empty: "Please type a message.",
  closed: "This chat is closed.",
  no_links: "Links and website names aren't allowed here. Please send it without them.",
  slow_down: "Please wait a few seconds between messages.",
  rate_limited: "That's a lot of messages. Please try again in an hour.",
  full: "This chat is full.",
};

/** The message list. Also served on its own, so the page can refresh it without reloading. */
export function chatMessages(csrf: string, uid: string, p: ChatPage): Html {
  if (p.messages.length === 0) return html`<li class="muted">No messages yet.</li>`;
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: p.event.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return html`${p.messages.map((m) => html`<li class="${m.organizer ? "org" : ""}">
    <p class="who"><strong>${m.name}</strong> <span class="muted">${time(m.at)}</span></p>
    <p class="said" dir="auto">${m.body}</p>
    ${p.moderator
      ? html`<form method="post" action="/chat/${uid}/remove/${m.id}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" class="link">Remove</button></form>`
      : m.organizer ? "" : html`<form method="post" action="/chat/${uid}/report/${m.id}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" class="link">Report</button></form>`}
  </li>`)}`;
}

export function chatPage(csrf: string, uid: string, p: ChatPage, note?: { error?: string; done?: string }): Html {
  const title = p.event.title ?? "An event on a private calendar";
  return publicLayout(`Chat: ${title}`, html`<div class="card">
  <p class="muted">Event chat</p>
  <h1 dir="auto">${title}</h1>
  <p><strong>${formatWhen(p.event)}</strong>${p.event.calendar ? html` · <span dir="auto">${p.event.calendar}</span>` : ""}</p>
  ${note?.error ? html`<p class="error" role="alert">${note.error}</p>` : ""}
  ${note?.done ? html`<p class="status" role="status">${note.done}</p>` : ""}
  ${!p.on
    ? html`<p class="status">The organizer has switched this chat off.</p>`
    : html`<ol class="chat" id="chat" ${p.open ? html`data-live="/chat/${uid}/messages"` : ""} aria-live="polite">${chatMessages(csrf, uid, p)}</ol>
  ${p.open
    ? html`<form method="post" action="/chat/${uid}">
    <input type="hidden" name="csrf" value="${csrf}">
    <p><label for="message">Your message</label><textarea id="message" name="message" rows="2" maxlength="300" required dir="auto"></textarea></p>
    <button type="submit">Send</button>
  </form>
  <p class="muted">${p.moderator
    ? "You run this calendar: your messages show as Organizer, and you can remove any message."
    : "You're anonymous here: you get a made-up name, and we don't ask for yours. Everyone following this event can read what you write, so don't share anything private. No links. The organizer can remove messages."}</p>`
    : html`<p class="status">This chat is closed because the event is over.</p>`}`}
  <p class="muted">Messages here are from followers, not from Calantern, and may be wrong. For the facts, trust the event itself.</p>
</div>`);
}

export function registerChatRoutes(app: Hono<AppEnv>): void {
  const load = async (c: Context<AppEnv>, uid: string): Promise<ChatPage | null> => {
    const { data, error } = await c.get("supabase").rpc("chat_page", { p_event_uid: uid });
    if (error) throw new Error("chat_page failed");
    const parsed = ChatPage.safeParse(data);
    return parsed.success ? parsed.data : null;
  };
  const none = (c: Context<AppEnv>) => c.html(messagePage("No chat here", "This event has no chat, or the link isn't complete. Please open it again from the event in your calendar."), 404);
  const form = async (c: Context<AppEnv>): Promise<Record<string, string>> =>
    Object.fromEntries(Object.entries(await c.req.parseBody()).filter((e): e is [string, string] => typeof e[1] === "string"));
  const headers = (c: Context<AppEnv>) => { c.header("x-robots-tag", "noindex"); c.header("cache-control", "no-store"); };
  const DONE: Record<string, string> = { reported: "Thanks. The organizer can see reported messages, and a message several people report is hidden.", removed: "Removed." };

  app.get("/chat/:uid", async (c) => {
    headers(c);
    const uid = Uid.safeParse(c.req.param("uid"));
    if (!uid.success) return none(c);
    const page = await load(c, uid.data);
    if (!page) return none(c);
    const done = DONE[c.req.query("done") ?? ""];
    return c.html(chatPage(csrfToken(c), uid.data, page, done ? { done } : undefined));
  });

  // Just the list, for the page's own refresh every few seconds.
  app.get("/chat/:uid/messages", async (c) => {
    headers(c);
    const uid = Uid.safeParse(c.req.param("uid"));
    const page = uid.success ? await load(c, uid.data) : null;
    if (!uid.success || !page || !page.on) return c.body(null, 404);
    return c.html(html`${chatMessages(csrfToken(c), uid.data, page)}`);
  });

  app.post("/chat/:uid", async (c) => {
    headers(c);
    const uid = Uid.safeParse(c.req.param("uid"));
    if (!uid.success) return none(c);
    const page = await load(c, uid.data);
    if (!page) return none(c);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(chatPage(csrfToken(c), uid.data, page, { error: MESSAGES.badForm }), 403);
    const ip = c.req.header("cf-connecting-ip");
    const { data, error } = await c.get("supabase").rpc("chat_post", { p_event_uid: uid.data, p_body: (body.message ?? "").slice(0, 300), ...(ip ? { p_client_ip: ip } : {}) });
    if (error) throw new Error("chat_post failed");
    if (data !== "ok") {
      const why = REFUSED[String(data)] ?? REFUSED.closed ?? "";
      return c.html(chatPage(csrfToken(c), uid.data, page, { error: why }), data === "slow_down" || data === "rate_limited" || data === "full" ? 429 : 400);
    }
    c.get("log").info("chat_posted");
    return c.redirect(`/chat/${encodeURIComponent(uid.data)}`, 303);
  });

  const act = (path: string, fn: "chat_report" | "chat_remove", done: string) => {
    app.post(path, async (c) => {
      headers(c);
      const uid = Uid.safeParse(c.req.param("uid"));
      const mid = Mid.safeParse(c.req.param("mid"));
      if (!uid.success || !mid.success) return none(c);
      const body = await form(c);
      if (!csrfValid(c, body.csrf)) return c.text(MESSAGES.badForm, 403);
      const ip = c.req.header("cf-connecting-ip");
      const sb = c.get("supabase");
      const { error } = fn === "chat_report"
        ? await sb.rpc("chat_report", { p_message_id: mid.data, ...(ip ? { p_client_ip: ip } : {}) })
        : await sb.rpc("chat_remove", { p_message_id: mid.data });
      if (error) throw new Error(`${fn} failed`);
      c.get("log").info(fn);
      return c.redirect(`/chat/${encodeURIComponent(uid.data)}?done=${done}`, 303);
    });
  };
  act("/chat/:uid/report/:mid", "chat_report", "reported");
  act("/chat/:uid/remove/:mid", "chat_remove", "removed");
}
