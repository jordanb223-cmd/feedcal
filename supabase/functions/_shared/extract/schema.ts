// What the model must return (strict JSON schema via structured outputs) and its Zod twin.
import { z } from "npm:zod@4.6.7";

export const SourceRef = z.object({
  kind: z.enum(["body", "page"]),
  attachment_id: z.string().nullable(),
  page_index: z.number().int().min(0).nullable(),
});

export const ExtractedEvent = z.object({
  title: z.string().min(1).max(300),
  // Local wall time in `timezone`: "YYYY-MM-DDTHH:MM" for timed events, "YYYY-MM-DD" for all-day.
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).nullable(),
  all_day: z.boolean(),
  timezone: z.string().min(1).max(64),
  location: z.string().max(500).nullable(),
  description: z.string().max(2000).nullable(),
  recurrence: z.string().max(300).nullable(), // an RRULE value, e.g. "FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261219"
  status: z.enum(["new", "changed", "cancelled"]),
  confidence: z.number().min(0).max(1),
  evidence_quote: z.string().min(3).max(1000),
  source_ref: SourceRef,
});
export type ExtractedEvent = z.infer<typeof ExtractedEvent>;

export const ExtractionOutput = z.object({ events: z.array(ExtractedEvent).max(60) });
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

/** JSON Schema for output_config.format. Kept in step with the Zod schema by a test. */
export const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "start", "end", "all_day", "timezone", "location", "description", "recurrence", "status", "confidence", "evidence_quote", "source_ref"],
        properties: {
          title: { type: "string" },
          start: { type: "string" },
          end: nullable({ type: "string" }),
          all_day: { type: "boolean" },
          timezone: { type: "string" },
          location: nullable({ type: "string" }),
          description: nullable({ type: "string" }),
          recurrence: nullable({ type: "string" }),
          status: { type: "string", enum: ["new", "changed", "cancelled"] },
          confidence: { type: "number" },
          evidence_quote: { type: "string" },
          source_ref: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "attachment_id", "page_index"],
            properties: {
              kind: { type: "string", enum: ["body", "page"] },
              attachment_id: nullable({ type: "string" }),
              page_index: nullable({ type: "integer" }),
            },
          },
        },
      },
    },
  },
} as const;
