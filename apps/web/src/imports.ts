// D48: an organizer can copy events from a calendar link (.ics) into their own Feedcal calendar.
// A tucked-away option, not the main path. Default: a one-time copy the organizer then owns
// (self-hosted); optional: keep checking the link daily. Owner only (checked in SQL).
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { csrfValid } from "./security.js";
import type { AppEnv } from "./types.js";
import { messagePage } from "./views.js";

const FeedId = z.uuid();
export const ImportStatus = z.object({
  url: z.string().nullable(), mode: z.enum(["once", "daily"]), imported_at: z.string().nullable(), events: z.number(),
}).nullable();
export type ImportStatus = z.infer<typeof ImportStatus>;

const csrfField = (t: string) => html`<input type="hidden" name="csrf" value="${t}">`;

/** The small form: paste a link, optionally keep it updating. Used on setup and in Settings. */
export function importForm(feedId: string, t: string, back: "setup" | "settings") {
  return html`<form method="post" action="/feeds/${feedId}/import">${csrfField(t)}<input type="hidden" name="back" value="${back}">
    <p><label for="import-url">Calendar link (.ics or webcal)</label>
      <input class="copy" id="import-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" required maxlength="2000" placeholder="https://…/calendar.ics"></p>
    <p><label class="check"><input type="checkbox" name="keep" value="1">
      <span>Keep checking this link every day <span class="muted">(otherwise Calantern copies the events once, and you keep them up to date)</span></span></label></p>
    <button type="submit" class="secondary">Copy events</button></form>`;
}

/** What Settings shows about an import that's set up. */
export function importStatus(feedId: string, t: string, s: ImportStatus) {
  if (!s?.url) return html`${s && s.events > 0 ? html`<p class="muted">${s.events} copied ${s.events === 1 ? "event" : "events"} on this calendar.</p>` : ""}${importForm(feedId, t, "settings")}`;
  return html`<p>${s.mode === "daily" ? "Checking every day:" : "Copying once from:"} <span class="muted" style="overflow-wrap:anywhere">${s.url}</span></p>
    <p class="muted">${s.imported_at ? `${s.events} ${s.events === 1 ? "event" : "events"} so far.` : "Waiting for the first copy (usually within 10 minutes)."}</p>
    <form method="post" action="/feeds/${feedId}/import/stop">${csrfField(t)}<button type="submit" class="secondary">Stop using this link</button></form>
    <p class="muted" style="font-size:.875rem">Stopping keeps the events already copied.</p>`;
}

const NOTICES: Record<string, string> = {
  started: "Got it. Calantern will copy the events within about 10 minutes.",
  stopped: "Stopped. The events already copied are still on the calendar.",
};
export const importNotice = (k: string | undefined) => (k ? NOTICES[k] : undefined);

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const b = await c.req.parseBody();
  return Object.fromEntries(Object.entries(b).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export function registerImportRoutes(app: Hono<AppEnv>): void {
  app.post("/feeds/:id/import", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Calendar not found", "That calendar doesn't exist."), 404);
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await form(c);
    const back = body.back === "setup" ? `/feeds/${id.data}/setup` : `/feeds/${id.data}/settings`;
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: back, text: "Back" }), 403);
    const { data, error } = await c.get("supabase").rpc("feed_import_set", { p_feed_id: id.data, p_url: body.url ?? "", p_keep_updating: body.keep === "1" });
    if (error) return c.html(messagePage("Not allowed", "Only the calendar's owner can import into it."), 403);
    if (data === "bad_url") return c.html(messagePage("That link won't work", "Use a calendar link that starts with https:// or webcal:// (it usually ends in .ics).", { href: back, text: "Back" }), 400);
    if (data === "too_many") return c.html(messagePage("Try again tomorrow", "You've set up a lot of imports today. Please wait a day and try again.", { href: back, text: "Back" }), 429);
    c.get("log").info("import_set", { feed_id: id.data, keep: body.keep === "1" });
    return c.redirect(`/feeds/${id.data}/settings?import=started`, 303);
  });

  app.post("/feeds/:id/import/stop", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Calendar not found", "That calendar doesn't exist."), 404);
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await form(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/settings`, text: "Back" }), 403);
    const { error } = await c.get("supabase").rpc("feed_import_stop", { p_feed_id: id.data });
    if (error) return c.html(messagePage("Not allowed", "Only the calendar's owner can change this."), 403);
    return c.redirect(`/feeds/${id.data}/settings?import=stopped`, 303);
  });
}

