import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  commit: z.string(),
  environment: z.enum(["local", "staging", "production"]),
  database: z.object({
    reachable: z.boolean(),
    latency_ms: z.number().nonnegative().nullable(),
  }),
  request_id: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const Environment = z.enum(["local", "staging", "production"]);
export type Environment = z.infer<typeof Environment>;
