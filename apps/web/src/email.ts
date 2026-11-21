import type { Context, Hono } from "hono";
import { z } from "zod";
import { currentUser, MESSAGES } from "./auth.js";
import { EMAIL_NOTICES, emailSetupPage, type EmailNotice, type SuspiciousMessage, type WaitingSender } from "./email-views.js";
import { csrfToken, csrfValid } from "./security.js";
import type { AppEnv } from "./types.js";
import { messagePage } from "./views.js";

const Id = z.uuid();
const SenderDecision = z.object({ decision: z.enum(["yes", "no"]) });
const MessageDecision = z.object({ decision: z.enum(["release", "ignore"]) });
const Notice = z.enum(Object.keys(EMAIL_NOTICES) as [EmailNotice, ...EmailNotice[]]);

const notFound = (c: Context<AppEnv>) => c.html(messagePage("Feed not found", "That feed doesn't exist, or it isn't yours."), 404);

/** Owner or editor check comes from RLS: a stranger simply can't select the feed. */
async function loadFeed(c: Context<AppEnv>, id: string) {
  const { data } = await c.get("supabase").from("feeds").select("id, name, owner_id, intake_address").eq("id", id).maybeSingle();
  return data;
}

async function formBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export function registerEmailRoutes(app: Hono<AppEnv>): void {
  app.get("/feeds/:id/email", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const user = await currentUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/email`)}`, 303);
    const feed = await loadFeed(c, id.data);
    if (!feed) return notFound(c);
    const sb = c.get("supabase");

    const [{ data: waiting }, { data: confirmations }] = await Promise.all([
      sb.from("messages").select("id, source_id, sender, subject, received_at, quarantine_reason")
        .eq("feed_id", id.data).not("quarantine_reason", "is", null).order("received_at", { ascending: false }).limit(200),
      sb.from("forwarding_confirmations").select("code, confirm_url, requested_by, expires_at")
        .eq("feed_id", id.data).gt("expires_at", new Date().toISOString()).order("received_at", { ascending: false }).limit(1),
    ]);

    const senders = new Map<string, WaitingSender>();
    const suspicious: SuspiciousMessage[] = [];
    for (const m of waiting ?? []) {
      if (m.quarantine_reason === "new_sender" && m.source_id && m.sender) {
        const s = senders.get(m.source_id) ?? { sourceId: m.source_id, sender: m.sender, count: 0, latestSubject: m.subject };
        s.count += 1;
        senders.set(m.source_id, s);
      } else {
        suspicious.push({ id: m.id, sender: m.sender, subject: m.subject, receivedAt: m.received_at });
      }
    }
    const conf = confirmations?.[0];
    const domain = c.env.INTAKE_DOMAIN?.trim();
    const notice = Notice.safeParse(c.req.query("done"));
    return c.html(
      emailSetupPage({
        csrf: csrfToken(c),
        feedId: feed.id,
        name: feed.name,
        isOwner: feed.owner_id === user.id,
        address: domain ? `${feed.intake_address}@${domain}` : null,
        localPart: feed.intake_address,
        confirmation: conf ? { code: conf.code, url: conf.confirm_url, requestedBy: conf.requested_by } : null,
        senders: [...senders.values()],
        suspicious,
        ...(notice.success ? { notice: notice.data } : {}),
      }),
    );
  });

  // Every decision is a POST that redirects back (PRG). Deciding twice is harmless: the second
  // call finds nothing waiting.
  app.post("/feeds/:id/senders/:sourceId", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    const sourceId = Id.safeParse(c.req.param("sourceId"));
    if (!id.success || !sourceId.success) return notFound(c);
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await formBody(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/email`, text: "Back" }), 403);
    const parsed = SenderDecision.safeParse(body);
    if (!parsed.success) return c.html(messagePage("Please try again", "Please choose yes or no.", { href: `/feeds/${id.data}/email`, text: "Back" }), 400);
    const trust = parsed.data.decision === "yes";
    const { error } = await c.get("supabase").rpc("decide_sender", { p_source_id: sourceId.data, p_trust: trust });
    if (error) return notFound(c);
    c.get("log").info("sender_decided", { feed_id: id.data, trust });
    return c.redirect(`/feeds/${id.data}/email?done=${trust ? "approved" : "declined"}`, 303);
  });

  app.post("/feeds/:id/messages/:messageId", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    const messageId = Id.safeParse(c.req.param("messageId"));
    if (!id.success || !messageId.success) return notFound(c);
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await formBody(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/email`, text: "Back" }), 403);
    const parsed = MessageDecision.safeParse(body);
    if (!parsed.success) return c.html(messagePage("Please try again", "Please choose an option.", { href: `/feeds/${id.data}/email`, text: "Back" }), 400);
    const release = parsed.data.decision === "release";
    const { error } = await c.get("supabase").rpc("decide_message", { p_message_id: messageId.data, p_release: release });
    // Already decided (double tap) lands on the page without an error.
    if (error) return c.redirect(`/feeds/${id.data}/email`, 303);
    c.get("log").info("message_decided", { feed_id: id.data, release });
    return c.redirect(`/feeds/${id.data}/email?done=${release ? "released" : "ignored"}`, 303);
  });

  app.post("/feeds/:id/rotate-intake", async (c) => {
    const id = Id.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    if (!(await currentUser(c))) return c.redirect("/login", 303);
    const body = await formBody(c);
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/email`, text: "Back" }), 403);
    const { error } = await c.get("supabase").rpc("rotate_intake_address", { p_feed_id: id.data });
    if (error) return c.html(messagePage("Not allowed", "Only the feed's owner can change its email address."), 403);
    c.get("log").info("intake_address_rotated", { feed_id: id.data });
    return c.redirect(`/feeds/${id.data}/email?done=rotated`, 303);
  });
}
