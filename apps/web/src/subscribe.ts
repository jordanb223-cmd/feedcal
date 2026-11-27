import type { Context, Hono } from "hono";
import { renderSVG } from "uqr";
import { z } from "zod";
import { PublicFeedPage } from "@feedcal/shared";
import { currentUser, MESSAGES } from "./auth.js";
import { feedUrl } from "./feed.js";
import { csrfToken, csrfValid, originOf } from "./security.js";
import { detectDevice, GO_TARGETS, platformOf, subscribeLinks, type GoTarget } from "./subscribe-links.js";
import { flyerPage, shareKitPage, statusPage, subscribePage } from "./subscribe-views.js";
import type { AppEnv } from "./types.js";
import { messagePage } from "./views.js";

const Slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/);
const FeedId = z.uuid();
const Target = z.enum(Object.keys(GO_TARGETS) as [GoTarget, ...GoTarget[]]);
const FeedRow = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), visibility: z.enum(["public", "unlisted", "private"]) });
const When = z.string().nullable();
const Status = z.object({
  name: z.string().nullable(), organizer_name: z.string().nullable(), slug: z.string().nullable(), last_updated_at: z.string(), last_email_at: When, upcoming: z.number().int(),
  gmail: z.object({ state: z.enum(["working", "disconnected"]), last_checked_at: When, next_check_at: When, disconnected_since: When, renewed_at: When }).nullable(),
});
const Stats = z.object({ subscribers_at_least: z.number().int(), clicks_30d: z.record(z.string(), z.number().int()) });

function qr(text: string): string {
  return renderSVG(text, { border: 2, pixelSize: 8 });
}

async function loadPublicPage(c: Context<AppEnv>, slug: string): Promise<PublicFeedPage | null> {
  const { data, error } = await c.get("supabase").rpc("public_feed_page", { p_slug: slug, p_limit: 5 });
  if (error) throw new Error("public_feed_page failed");
  if (data === null) return null;
  const parsed = PublicFeedPage.safeParse(data);
  if (!parsed.success) throw new Error("public_feed_page returned an unexpected shape");
  return parsed.data;
}

const notFoundPage = (c: Context<AppEnv>) => {
  c.header("x-robots-tag", "noindex");
  return c.html(messagePage("Calendar not found", "This calendar doesn't exist, or its owner made it private. Check the link with the person who shared it."), 404);
};

async function tapAllowed(c: Context<AppEnv>): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip");
  if (!ip) return true;
  const { data, error } = await c.get("supabase").rpc("rate_check", { p_bucket: "click", p_client_ip: ip });
  return !error && data === true;
}

export function registerSubscribeRoutes(app: Hono<AppEnv>): void {
  // The public subscribe page [Rev 3]. Private feeds never have one.
  app.get("/c/:slug", async (c) => {
    const slug = Slug.safeParse(c.req.param("slug"));
    if (!slug.success) return notFoundPage(c);
    const page = await loadPublicPage(c, slug.data);
    if (!page) return notFoundPage(c);
    const pageUrl = `${originOf(c)}/c/${page.feed.slug}`;
    const links = subscribeLinks(feedUrl(c, page.feed.feed_token), page.feed.name);
    if (page.feed.visibility === "unlisted") c.header("x-robots-tag", "noindex");
    // Public pages may be cached briefly; they carry no session data.
    c.header("cache-control", "public, max-age=60");
    return c.html(subscribePage({ page, device: detectDevice(c.req.header("user-agent")), links, pageUrl }));
  });

  // D87: the calendar's health page, linked from every event (a short address keeps that link small). Any calendar has one, private ones
  // included: the link is only in the calendar's own events, and the page shows no event details.
  app.get("/h/:id", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    c.header("x-robots-tag", "noindex");
    if (!id.success) return notFoundPage(c);
    const { data, error } = await c.get("supabase").rpc("feed_status", { p_feed_id: id.data });
    if (error) throw new Error("feed_status failed");
    const parsed = Status.safeParse(data);
    if (!parsed.success) return notFoundPage(c);
    c.header("cache-control", "public, max-age=60");
    c.header("referrer-policy", "no-referrer");
    return c.html(statusPage(parsed.data));
  });

  // A subscribe button: count the tap [Rev 4], then hand off to the calendar app.
  // Works without JavaScript; the count has no personal data.
  app.get("/c/:slug/go/:target", async (c) => {
    const slug = Slug.safeParse(c.req.param("slug"));
    const target = Target.safeParse(c.req.param("target"));
    if (!slug.success || !target.success) return notFoundPage(c);
    const page = await loadPublicPage(c, slug.data);
    if (!page) return notFoundPage(c);
    // Taps are counted at most 30 a minute per address (D37); the hand-off always works.
    if (await tapAllowed(c)) {
      const { error } = await c.get("supabase").rpc("record_subscribe_click", { p_slug: slug.data, p_platform: platformOf(target.data) });
      if (error) c.get("log").warn("subscribe_click_not_recorded");
    }
    const links = subscribeLinks(feedUrl(c, page.feed.feed_token), page.feed.name);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(GO_TARGETS[target.data](links), 302);
  });

  // The "Copy link" button reports its tap here (same-origin POST; best effort).
  app.post("/c/:slug/copied", async (c) => {
    const slug = Slug.safeParse(c.req.param("slug"));
    if (slug.success && (await tapAllowed(c))) await c.get("supabase").rpc("record_subscribe_click", { p_slug: slug.data, p_platform: "copy_link" });
    return c.body(null, 204);
  });

  // The owner's share kit [Rev 1]: page link, calendar link, QR, group-chat text, stats, rotation.
  app.get("/feeds/:id/share", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Calendar not found", "That calendar doesn't exist."), 404);
    const user = await currentUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/share`)}`, 303);
    const kit = await loadShareKit(c, id.data);
    if (!kit) return c.html(messagePage("Calendar not found", "That calendar doesn't exist, or it isn't yours."), 404);
    const notice = c.req.query("rotated") === "1" ? "New link made. The old link has stopped working; anyone using it needs the new one." : undefined;
    const inviteNotice = INVITE_NOTICES[c.req.query("invite") ?? ""];
    const ready = c.req.query("ready") === "gmail"; // D47: the end of Gmail setup
    return c.html(shareKitPage({ csrf: csrfToken(c), ...kit, ...(notice ? { notice } : {}), ...(inviteNotice ? { inviteNotice } : {}), ready }));
  });

  // D94: Bumpdraft emails one person an invitation. The limits and checks are in public.send_invite.
  app.post("/feeds/:id/invite", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Calendar not found", "That calendar doesn't exist."), 404);
    const user = await currentUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/share`)}`, 303);
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/share`, text: "Back" }), 403);
    const email = typeof body.email === "string" ? body.email.trim().slice(0, 320) : "";
    const { data, error } = await c.get("supabase").rpc("send_invite", { p_feed_id: id.data, p_email: email });
    const outcome = !error && typeof data === "string" && data in INVITE_NOTICES ? data : "error";
    c.get("log").info("invite", { outcome });
    return c.redirect(`/feeds/${id.data}/share?invite=${outcome}#email-it`, 303);
  });

  app.get("/feeds/:id/flyer", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Calendar not found", "That calendar doesn't exist."), 404);
    const user = await currentUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/feeds/${id.data}/flyer`)}`, 303);
    const kit = await loadShareKit(c, id.data);
    if (!kit) return c.html(messagePage("Calendar not found", "That calendar doesn't exist, or it isn't yours."), 404);
    const url = kit.pageUrl ?? kit.feedUrl;
    return c.html(flyerPage({ name: kit.name, url, qrSvg: kit.qrSvg, feedId: id.data, half: c.req.query("half") === "1" }));
  });

  // Old address for the link page; the share kit replaces it.
  app.get("/feeds/:id/link", (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    return id.success ? c.redirect(`/feeds/${id.data}/share`, 301) : c.html(messagePage("Calendar not found", "That calendar doesn't exist."), 404);
  });
}

/** What the Share page says after "Send the invitation". The words come from public.send_invite. */
const INVITE_NOTICES: Record<string, string> = {
  sent: "Invitation on its way. It should arrive within a few minutes.",
  invalid: "That doesn't look like an email address. Check it and try again.",
  already: "That person was already invited to this calendar in the last 30 days.",
  opted_out: "That person has asked Bumpdraft not to send them invitations. You can still email them yourself.",
  limit: "You've sent 10 invitations today, which is the daily limit. You can still email people yourself, or send more tomorrow.",
  busy: "Bumpdraft has sent all the invitations it can today. You can still email people yourself, or try again tomorrow.",
  private: "This calendar is private, so Bumpdraft can't send an invitation for it. You can still email the link yourself.",
  not_allowed: "Only the people who run this calendar can send invitations.",
  error: "The invitation couldn't be sent. Please try again in a minute.",
};

async function loadShareKit(c: Context<AppEnv>, feedId: string) {
  const sb = c.get("supabase");
  const { data: row } = await sb.from("feeds").select("id, name, slug, visibility").eq("id", feedId).maybeSingle();
  const feed = FeedRow.safeParse(row);
  if (!feed.success) return null;
  const { data: token, error } = await sb.rpc("get_feed_token", { p_feed_id: feedId });
  if (error || typeof token !== "string") return null;
  const { data: statsRaw } = await sb.rpc("feed_subscribe_stats", { p_feed_id: feedId });
  const stats = Stats.safeParse(statsRaw);
  const fUrl = feedUrl(c, token);
  const pageUrl = feed.data.visibility === "private" ? null : `${originOf(c)}/c/${feed.data.slug}`;
  const shareUrl = pageUrl ?? fUrl;
  return {
    feedId,
    name: feed.data.name,
    visibility: feed.data.visibility,
    pageUrl,
    feedUrl: fUrl,
    qrSvg: qr(shareUrl),
    chatText: `Get ${feed.data.name} in your phone's calendar. It updates on its own: ${shareUrl}`,
    stats: stats.success ? stats.data : null,
  };
}
