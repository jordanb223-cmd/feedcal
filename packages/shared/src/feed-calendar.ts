import { z } from "zod";

/** The JSON returned by the public.feed_calendar() RPC. Validated before use (rule 3). */
export const FeedCalendarEvent = z.object({
  id: z.uuid(),
  uid: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  description: z.string().max(8000).nullable(),
  location: z.string().max(500).nullable(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  all_day: z.boolean(),
  timezone: z.string().min(1).max(64),
  rrule: z.string().max(500).nullable(),
  exdates: z.array(z.string()).max(500).optional().default([]),
  status: z.enum(["tentative", "confirmed", "cancelled"]),
  sequence: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  source: z.string().max(253).nullable(),
  /** D89: this event has a chat that is open right now. */
  chat: z.boolean().optional(),
});

export const FeedCalendarData = z.object({
  feed: z.object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
    slug: z.string(),
    description: z.string().nullable(),
    visibility: z.enum(["public", "unlisted", "private"]),
    last_updated_at: z.string(),
    /** D86: when the calendar's Gmail connection lapsed, once that is 20 days or more ago. */
    source_lapsed_since: z.string().nullable().optional(),
  }),
  events: z.array(FeedCalendarEvent).max(2000),
});
export type FeedCalendarData = z.infer<typeof FeedCalendarData>;

/** A feed token as minted by the database: 43 URL-safe base64 characters. */
export const FeedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
