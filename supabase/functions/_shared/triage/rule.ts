// The owner's learned rule for a sender (sources.attachment_rule), written by the
// choose_attachment / never_use_attachment / set_sender_large_attachments SQL functions.
import { z } from "npm:zod@4.6.7";

const Entry = z.object({ pattern: z.string().max(600), mime: z.string().max(255).nullable().optional(), pages: z.array(z.number().int().min(0)).max(40).optional() });
export const AttachmentRule = z.object({
  version: z.literal(1).optional(),
  prefer: z.array(Entry).max(5).optional(),
  never: z.array(Entry).max(20).optional(),
  allowLarge: z.boolean().optional(),
});
export type AttachmentRule = z.infer<typeof AttachmentRule>;
type Entry = z.infer<typeof Entry>;

/** A bad or missing rule is treated as no rule, never as an error. */
export function readRule(value: unknown): AttachmentRule {
  const parsed = AttachmentRule.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

function matches(entry: Entry, filename: string | null, mime: string): boolean {
  if (entry.mime && entry.mime !== mime) return false;
  try {
    return new RegExp(entry.pattern, "i").test((filename ?? "").toLowerCase());
  } catch {
    return false;
  }
}

export function preferredMatch(rule: AttachmentRule, filename: string | null, mime: string): Entry | null {
  return rule.prefer?.find((e) => matches(e, filename, mime)) ?? null;
}

export function isNever(rule: AttachmentRule, filename: string | null, mime: string): boolean {
  return rule.never?.some((e) => matches(e, filename, mime)) ?? false;
}
