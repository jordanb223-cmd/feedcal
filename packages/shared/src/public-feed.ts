import { z } from "zod";

/** The JSON returned by the public.public_feed_page() RPC. Validated before use (rule 3). */
export const PublicFeedPage = z.object({
  feed: z.object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
    slug: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    zip_code: z.string().nullable(),
    area: z.string().nullable(),
    visibility: z.enum(["public", "unlisted"]),
    last_updated_at: z.string(),
    organizer_name: z.string().nullable(),
    subscribers_at_least: z.number().int().nonnegative(),
    may_be_out_of_date: z.boolean().optional().default(false),
    verified: z.boolean().optional().default(false),
    feed_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  events: z.array(
    z.object({
      id: z.uuid(),
      uid: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      location: z.string().nullable(),
      starts_at: z.string(),
      ends_at: z.string().nullable(),
      all_day: z.boolean(),
      timezone: z.string(),
      rrule: z.string().nullable(),
      /** A repeating event: `starts_at` is then its next coming date, not its first. */
      repeats: z.boolean().optional(),
      status: z.enum(["tentative", "confirmed", "cancelled"]),
    }),
  ),
});
export type PublicFeedPage = z.infer<typeof PublicFeedPage>;

export const SubscribePlatform = z.enum(["apple", "google", "outlook", "copy_link", "other"]);
export type SubscribePlatform = z.infer<typeof SubscribePlatform>;
