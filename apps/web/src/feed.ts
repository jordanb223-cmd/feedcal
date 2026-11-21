import type { Context, Hono } from "hono";
import { z } from "zod";
import { buildCalendar, type CalendarEvent } from "@feedcal/ics";
import { FeedCalendarData, FeedToken } from "@feedcal/shared";
import { currentUser, MESSAGES } from "./auth.js";
import { csrfValid, originOf } from "./security.js";
import type { AppEnv } from "./types.js";
import { messagePage } from "./views.js";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const FeedId = z.uuid();

/** Coarse calendar-client family for fetch stats. The full user agent is never stored. */
export function userAgentFamily(ua: string | undefined): "google" | "apple" | "outlook" | "other" {
  if (!ua) return "other";
  if (/Google-Calendar-Importer|Google/i.test(ua)) return "google";
  if (/Outlook|Microsoft|Exchange/i.test(ua)) return "outlook";
  if (/iOS|iPhone|iPad|Mac ?OS|CalendarAgent|dataaccessd|Darwin/i.test(ua)) return "apple";
  return "other";
}

async function etagFor(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return `"${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === etag || v === "*";
  });
}

export function feedUrl(c: Context<AppEnv>, token: string): string {
  return `${originOf(c)}/f/${token}.ics`;
}

export function registerFeedRoutes(app: Hono<AppEnv>): void {
  // The subscribable feed. The token in the URL is the only credential; it is never logged.
  app.get("/f/:file", async (c) => {
    const notFound = () => {
      c.header("cache-control", "no-store");
      c.header("x-robots-tag", "noindex");
      return c.text("Feed not found.", 404);
    };
    const match = /^(.+)\.ics$/.exec(c.req.param("file"));
    const token = FeedToken.safeParse(match?.[1]);
    if (!token.success) return notFound();

    const ua = c.req.header("user-agent");
    // Cloudflare sets cf-connecting-ip. Locally it's absent, so local fetches aren't counted.
    const ip = c.req.header("cf-connecting-ip");
    const { data, error } = await c.get("supabase").rpc("feed_calendar_guarded", {
      p_token: token.data,
      p_ua_family: userAgentFamily(ua),
      ...(ip ? { p_client_ip: ip } : {}),
      ...(ua ? { p_user_agent: ua } : {}),
    });
    if (error?.code === "P0429") {
      // This address asked for many calendars that don't exist (D37).
      c.header("retry-after", "600");
      c.header("cache-control", "no-store");
      return c.text("Too many requests. Try again in 10 minutes.", 429);
    }
    if (error) throw new Error("feed_calendar failed");
    if (data === null) return notFound();
    const parsed = FeedCalendarData.safeParse(data);
    if (!parsed.success) {
      c.get("log").error("feed_calendar_invalid_shape");
      throw new Error("feed_calendar returned an unexpected shape");
    }
    const { feed, events } = parsed.data;

    const calendarEvents: CalendarEvent[] = events.map((e) => ({
      uid: e.uid,
      title: e.title,
      description: e.description,
      location: e.location,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      allDay: e.all_day,
      timeZone: e.timezone,
      rrule: e.rrule,
      exdates: e.exdates,
      status: e.status,
      sequence: e.sequence,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      source: e.source,
    }));
    const origin = originOf(c);
    const { ics, warnings } = buildCalendar({ name: feed.name, description: feed.description }, calendarEvents, {
      defaultTimeZone: DEFAULT_TIME_ZONE,
      reportUrl: (uid) => `${origin}/report/${encodeURIComponent(uid)}`,
      product: "Feedcal",
    });
    if (warnings.length > 0) c.get("log").warn("feed_build_warnings", { feed_id: feed.id, count: warnings.length });

    const etag = await etagFor(ics);
    c.header("etag", etag);
    c.header("cache-control", "max-age=900");
    c.header("referrer-policy", "no-referrer");
    if (feed.visibility !== "public") c.header("x-robots-tag", "noindex");
    if (ifNoneMatchHits(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    c.header("content-type", "text/calendar; charset=utf-8");
    c.header("content-disposition", `inline; filename="${feed.slug}.ics"`);
    return c.body(ics, 200);
  });

  // (The "Report a problem" page each event links to lives in notify.ts since Phase 12.)

  // Make a new link; the old one stops working at once. Owner only (enforced in the database).
  app.post("/feeds/:id/rotate-token", async (c) => {
    const id = FeedId.safeParse(c.req.param("id"));
    if (!id.success) return c.html(messagePage("Feed not found", "That feed doesn't exist."), 404);
    const user = await currentUser(c);
    if (!user) return c.redirect("/login", 303);
    const body = await c.req.parseBody();
    if (!csrfValid(c, body.csrf)) return c.html(messagePage("Please try again", MESSAGES.badForm, { href: `/feeds/${id.data}/share`, text: "Back" }), 403);
    const { data: token, error } = await c.get("supabase").rpc("rotate_feed_token", { p_feed_id: id.data });
    if (error || typeof token !== "string") {
      return c.html(messagePage("Not allowed", "Only the feed's owner can make a new link."), 403);
    }
    c.get("log").info("feed_token_rotated", { feed_id: id.data });
    // Redirect after POST, so refreshing the page can't rotate the link a second time.
    return c.redirect(`/feeds/${id.data}/share?rotated=1`, 303);
  });
}
