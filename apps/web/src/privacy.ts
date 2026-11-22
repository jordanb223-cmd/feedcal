// Phase 16 privacy routes (D37): download everything Feedcal holds about you (JSON), each feed
// as an .ics file, and the plain-English privacy policy with its retention schedule.
import type { Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import { buildCalendar, type CalendarEvent } from "@feedcal/ics";
import { currentUser } from "./auth.js";
import { originOf } from "./security.js";
import type { AppEnv } from "./types.js";
import { messagePage, publicLayout } from "./views.js";

const DRAFT = html`<p class="muted"><strong>Draft.</strong> To be reviewed by a lawyer before public launch (see BUILD-PLAN "Non-negotiables").</p>`;

const ExportEvent = z.object({
  uid: z.string().optional(), id: z.string(), title: z.string(), description: z.string().nullable().optional(), location: z.string().nullable().optional(),
  starts_at: z.string(), ends_at: z.string().nullable().optional(), all_day: z.boolean().optional(), timezone: z.string().nullable().optional(),
  rrule: z.string().nullable().optional(), exdates: z.array(z.string()).nullable().optional(), status: z.string().optional(), sequence: z.number().optional(),
  created_at: z.string().optional(), updated_at: z.string().optional(), published: z.boolean().optional(),
}).passthrough();
const ExportFeed = z.object({ feed: z.object({ id: z.string(), name: z.string(), slug: z.string(), description: z.string().nullable().optional(), timezone: z.string().nullable().optional() }).passthrough(), events: z.array(ExportEvent) }).passthrough();

export function registerPrivacyRoutes(app: Hono<AppEnv>): void {
  app.get("/account/export", async (c) => {
    if (!(await currentUser(c))) return c.redirect("/login?next=/account", 303);
    const { data, error } = await c.get("supabase").rpc("export_my_data");
    if (error || !data) return c.html(messagePage("Something went wrong", "Please try again in a minute.", { href: "/account", text: "Back" }), 503);
    c.get("log").info("data_exported");
    c.header("content-type", "application/json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="feedcal-export-${new Date().toISOString().slice(0, 10)}.json"`);
    c.header("cache-control", "private, no-store");
    return c.body(JSON.stringify(data, null, 2));
  });

  // Every event of one feed you own or edit, drafts included, as a calendar file.
  app.get("/account/export/:file", async (c) => {
    if (!(await currentUser(c))) return c.redirect("/login?next=/account", 303);
    const id = /^([0-9a-f-]{36})\.ics$/.exec(c.req.param("file"))?.[1];
    const { data } = await c.get("supabase").rpc("export_my_data");
    const feeds = z.array(ExportFeed).safeParse((data as { feeds?: unknown } | null)?.feeds);
    const found = feeds.success ? feeds.data.find((f) => f.feed.id === id) : undefined;
    if (!found) return c.html(messagePage("Feed not found", "That feed doesn't exist, or it isn't yours."), 404);
    const events: CalendarEvent[] = found.events.map((e) => ({
      uid: e.uid ?? `${e.id}@feedcal.app`, title: e.title, description: e.description ?? null, location: e.location ?? null,
      startsAt: e.starts_at, endsAt: e.ends_at ?? null, allDay: e.all_day ?? false, timeZone: e.timezone ?? found.feed.timezone ?? "America/Los_Angeles",
      rrule: e.rrule ?? null, exdates: e.exdates ?? [], status: (e.status as CalendarEvent["status"]) ?? "confirmed", sequence: e.sequence ?? 0,
      createdAt: e.created_at ?? e.starts_at, updatedAt: e.updated_at ?? e.starts_at, source: null,
    }));
    const { ics } = buildCalendar({ name: found.feed.name, description: found.feed.description ?? null }, events, {
      defaultTimeZone: found.feed.timezone ?? "America/Los_Angeles", reportUrl: (uid) => `${originOf(c)}/report/${encodeURIComponent(uid)}`, product: "Calantern",
    });
    c.header("content-type", "text/calendar; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${found.feed.slug}-export.ics"`);
    c.header("cache-control", "private, no-store");
    return c.body(ics);
  });

  app.get("/privacy", (c) => c.html(publicLayout("Privacy", html`<div class="card"><h1>Privacy</h1>${DRAFT}
  <p>Calantern turns emails you forward into calendars. This page says what we keep, for how long, and what you can do about it.</p>
  <h2>What we keep</h2>
  <ul>
    <li><strong>Your account:</strong> your email address and, if you add one, your name.</li>
    <li><strong>Your calendars:</strong> their events, the senders you trust, and your settings.</li>
    <li><strong>Forwarded emails and attachments:</strong> so we can find events and show you where each one came from.</li>
    <li><strong>No card details:</strong> if you donate, Buy Me a Coffee takes the payment; we never see your card.</li>
    <li><strong>Counts, not people:</strong> how many calendar apps check a feed, and how many times subscribe buttons are tapped. We store a scrambled code instead of an address, and the code can't be traced back after 2 days.</li>
  </ul>
  <p><strong>Please don't forward emails with medical, legal or other sensitive details.</strong> Calantern reads everything you forward, and an AI service reads it too, so it can find events.</p>
  <p>We don't sell data, show ads, or use tracking cookies. Our only cookies keep you signed in and protect forms. They're deleted when you close your browser.</p>
  <h2>If you connect Gmail</h2>
  <ul>
    <li>Calantern only reads emails <strong>from the one sender you picked</strong>, plus the example you chose. It never sends, changes or deletes anything in your Gmail (read-only access).</li>
    <li>Those emails are handled like forwarded ones: kept 30 days, read by the AI service to find events, then deleted.</li>
    <li>Disconnecting Gmail removes Calantern's access at once and deletes every email it read from Gmail. You can also remove access in your Google Account settings.</li>
    <li>Calantern doesn't use Gmail data for ads, sell it, or use it to train AI models. People at Calantern don't read it unless you ask us to, it's needed for security, or the law requires it.</li>
    <li>Calantern's use of information received from Google APIs complies with the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</li>
  </ul>
  <h2>How long we keep it</h2>
  <ul>
    <li>Forwarded emails and their attachments: 30 days.</li>
    <li>Cancelled events: 30 days in calendars, so phones remove them.</li>
    <li>The "Undo" record after a change: 1 day.</li>
    <li>Sign-in and rate-limit records: 1 hour.</li>
    <li>Calendar check counts: 400 days.</li>
    <li>The contents of emails we sent you: 30 days.</li>
    <li>Backups: daily copies for 7 days and weekly copies for about 3 months, encrypted.</li>
    <li>Your account: until you delete it. After you ask, we wait 14 days (you can change your mind), then delete your personal data. Calendars you own go to a co-editor if they have one; otherwise they're deleted.</li>
  </ul>
  <h2>Who processes it</h2>
  <p>Supabase (database), Cloudflare (website and email receiving), Anthropic (the AI that reads forwarded emails), and Resend (emails we send). If you donate, Buy Me a Coffee handles the payment. See <a href="/about/costs">what Calantern costs</a>.</p>
  <h2>Your choices</h2>
  <ul>
    <li><a href="/account/export">Download everything we hold about you</a> (a JSON file), or each calendar as a calendar file from your account page.</li>
    <li>Delete your account any time from <a href="/account">your account page</a>.</li>
    <li>Turn off any email from us with the link at the bottom of it.</li>
  </ul>
</div>`)));
}
