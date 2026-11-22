// D61: organizers add a PDF, Word file, photo or text file to a calendar. The browser sends the
// file straight to private storage with a one-time link from the upload-file function; these
// routes only relay small JSON messages (Cloudflare's free plan allows 10 ms of CPU per request).
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { currentUser } from "./auth.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv } from "./types.js";
import { layout, messagePage } from "./views.js";

const FeedId = z.uuid();
export const UPLOAD_ACCEPT = ".pdf,.docx,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv,.ics,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/webp,image/gif,text/plain,text/csv,text/calendar";

/** The calendar, if the signed-in person can edit it (RLS lets members read their own editor row). */
async function editable(c: Context<AppEnv>, id: string): Promise<{ name: string } | null> {
  const user = await currentUser(c);
  if (!user) return null;
  const sb = c.get("supabase");
  const { data: member } = await sb.from("feed_editors").select("feed_id").eq("feed_id", id).eq("user_id", user.id).maybeSingle();
  if (!member) return null;
  const { data: feed } = await sb.from("feeds").select("name").eq("id", id).maybeSingle();
  return feed ? { name: feed.name } : null;
}

/** The link shown under "More ways to add events". */
export function uploadLink(feedId: string) {
  return html`<h3 style="margin:1rem 0 .25rem;font-size:1rem">Upload a newsletter or schedule</h3>
    <p class="muted" style="font-size:.875rem">A PDF, Word file or photo of a flyer. Calantern reads the dates the same way it reads emails.</p>
    <p><a class="button secondary" href="/feeds/${feedId}/upload">Upload a file</a></p>`;
}

/** The signed link on the public Supabase address; null unless it's a storage upload link. */
export function publicUrl(signed: string, supabaseUrl: string): string | null {
  try {
    const u = new URL(signed);
    const base = new URL(supabaseUrl);
    if (!/^\/storage\/v1\/object\/upload\/sign\/attachments\/[0-9a-f-]{36}\/upload-[0-9a-f-]{36}\/file\.[a-z0-9]{2,5}$/.test(u.pathname) || !u.searchParams.get("token")) return null;
    return `${base.origin}${base.pathname.replace(/\/$/, "")}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

async function relay(c: Context<AppEnv>, body: Record<string, unknown>) {
  const { data, error } = await c.get("supabase").functions.invoke("upload-file", { body });
  if (!error) return { status: 200, json: data as Record<string, unknown> };
  const ctx = (error as { context?: Response }).context;
  const status = ctx?.status && ctx.status >= 400 && ctx.status < 600 ? ctx.status : 503;
  const payload = ctx ? await ctx.json().catch(() => null) as Record<string, unknown> | null : null;
  return { status, json: { error: typeof payload?.error === "string" ? payload.error : "Please try again in a minute." } };
}

export function registerUploadRoutes(app: Hono<AppEnv>): void {
  app.get("/feeds/:id/upload", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Feed not found", "That feed doesn't exist."), 404);
    if (!(await currentUser(c))) return c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/upload`)}`, 303);
    const feed = await editable(c, id.data);
    if (!feed) return c.html(messagePage("Feed not found", "That feed doesn't exist, or you can't edit it."), 404);
    const done = c.req.query("done") === "1";
    return c.html(layout(`Upload to ${feed.name}`, html`<div class="card">
  <span class="kicker">Add events</span>
  <h1>Upload a file to <span dir="auto">${feed.name}</span></h1>
  ${done ? html`<p class="notice" role="status">Got it. Calantern is reading your file now. New events show up on the calendar within a few minutes, and anything it isn't sure about waits for you to check.</p>` : ""}
  <p>A school newsletter, a team schedule or a photo of a flyer. Calantern finds the dates in it, the same way it reads emails.</p>
  <form id="upload-form" method="post" action="/feeds/${id.data}/upload/start" data-feed="${id.data}">
    <input type="hidden" name="csrf" value="${csrfToken(c)}">
    <p><label for="upload-file">File</label><input class="copy" id="upload-file" name="file" type="file" required accept="${UPLOAD_ACCEPT}"></p>
    <p class="muted" style="font-size:.875rem">PDF, Word (.docx), JPEG, PNG, WebP, GIF, text or calendar files, up to 10 MB. Older Word files (.doc) can't be read: save them as .docx or PDF first.</p>
    <p id="upload-status" class="muted" role="status" aria-live="polite"></p>
    <noscript><p class="muted">Uploading needs JavaScript. You can also email the file to this calendar's address instead.</p></noscript>
    <button type="submit">Upload</button>
  </form>
  <p><a href="/feeds/${id.data}">Back to the calendar</a></p>
</div>`));
  });

  const step = (action: "start" | "finish") => async (c: Context<AppEnv>) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "That feed doesn't exist." }, 404);
    if (!(await currentUser(c))) return c.json({ error: "Please sign in again." }, 401);
    const body = await c.req.parseBody();
    if (!csrfValid(c, body.csrf)) return c.json({ error: "Please reload the page and try again." }, 403);
    const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const payload = action === "start"
      ? { action, feed_id: id.data, filename: s("filename").slice(0, 255), mime: s("mime").slice(0, 120), bytes: Number(s("bytes")) || 0 }
      : { action, ticket: s("ticket") };
    const r = await relay(c, payload);
    if (r.status !== 200) return c.json(r.json, r.status as 400);
    if (action === "start") {
      // The function signs the link with the address it sees itself by, which can be internal
      // (locally "kong:8000"). The browser needs the public address: same path and token.
      const signed = typeof r.json.url === "string" ? publicUrl(r.json.url, c.env.SUPABASE_URL) : null;
      if (!signed) return c.json({ error: "Please try again in a minute." }, 503);
      return c.json({ ticket: r.json.ticket, url: signed });
    }
    if (action === "finish") c.get("log").info("upload_finished", { feed_id: id.data });
    return c.json(action === "finish" ? { redirect: `/feeds/${id.data}/upload?done=1` } : r.json);
  };
  app.post("/feeds/:id/upload/start", step("start"));
  app.post("/feeds/:id/upload/finish", step("finish"));
}
