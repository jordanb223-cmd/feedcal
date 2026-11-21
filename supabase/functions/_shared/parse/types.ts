// ParsedMessage: what Phase 7 stores for each email and what later phases read.
import { z } from "npm:zod@4.6.7";

export const ParsedAttachment = z.object({
  filename: z.string().max(255).nullable(),
  mime: z.string().max(255),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  inline: z.boolean(),
  contentId: z.string().max(255).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export const DiscardedAttachment = z.object({
  filename: z.string().max(255).nullable(),
  mime: z.string().max(255),
  bytes: z.number().int().nonnegative(),
  reason: z.enum(["small_image", "decorative_image", "unreadable_or_signature"]),
});

export const ParsedMessage = z.object({
  version: z.literal(1),
  referenceDate: z.iso.datetime(),
  referenceDateSource: z.enum(["forwarded_header", "date_header", "received"]),
  sender: z.object({ address: z.string().max(320), name: z.string().max(320).nullable() }).nullable(),
  subject: z.string().max(998).nullable(),
  cleanText: z.string().max(100_000),
  strippedText: z.string().max(100_000),
  forwardNotes: z.array(z.string().max(10_000)).max(10),
  forwardDepth: z.number().int().min(0).max(10),
  bodySource: z.enum(["text", "html", "none"]),
  language: z.string().regex(/^([a-z]{2}|und)$/),
  attachments: z.array(ParsedAttachment).max(50),
  discarded: z.array(DiscardedAttachment).max(200),
});
export type ParsedMessage = z.infer<typeof ParsedMessage>;
export type ParsedAttachment = z.infer<typeof ParsedAttachment>;
