// Edge Function: Phase 9 consumer (D30). Claims triaged messages from "extract_message", asks the
// model for events, checks quotes and dates, records candidates, and queues "reconcile_message".
// Without ANTHROPIC_API_KEY (free tier) messages wait with state "waiting"; once a key is set,
// requeue_waiting_extractions() sends them back through.
import { claudeExtractor } from "../_shared/extract/extractor.ts";
import { extractEvents } from "../_shared/extract/pipeline.ts";
import type { ExtractInput } from "../_shared/extract/prompt.ts";
import { admin, carriesUser, json, log, notScheduler } from "../_shared/http.ts";

const TIME_BUDGET_MS = 100_000;

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (carriesUser(req)) return notScheduler();
  const db = admin();
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const extractor = apiKey ? claudeExtractor(apiKey) : null;
  const started = Date.now();
  const counts = { extracted: 0, review: 0, waiting: 0, retry: 0, gave_up: 0 };

  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: jobs, error } = await db.rpc("claim_extract_jobs", { p_limit: 3, p_visibility_seconds: 300 });
    if (error) return json({ error: "Try again later." }, 503);
    if (!jobs || jobs.length === 0) break;
    for (const job of jobs as { job_id: number; message_id: string | null; feed_id: string | null; context: ExtractInput | null }[]) {
      if (!job.message_id || !job.context || !job.feed_id) {
        await db.rpc("finish_extract_job", { p_job_id: job.job_id });
        continue;
      }
      try {
        const nothingToRead = !job.context.body.trim() && job.context.pages.length === 0;
        let waitReason: string | null = nothingToRead ? null : !extractor ? "no_api_key" : null;
        if (!waitReason && !nothingToRead) {
          const { data: granted } = await db.rpc("take_quota", { p_feed_id: job.feed_id, p_kind: "ai_calls", p_wanted: 1 });
          if (Number(granted ?? 0) < 1) waitReason = "daily_ai_limit";
        }
        if (waitReason) {
          await db.rpc("record_extraction_waiting", { p_message_id: job.message_id, p_reason: waitReason });
          await db.rpc("finish_extract_job", { p_job_id: job.job_id });
          counts.waiting++;
          continue;
        }
        const result = nothingToRead
          ? { state: "extracted" as const, reason: "nothing_to_read", candidates: [], rejected: [], calls: [], model: null }
          : await extractEvents(job.context, extractor!);
        const { error: recError } = await db.rpc("record_extraction", { p_message_id: job.message_id, p_result: result });
        if (recError) throw new Error("record_failed");
        await db.rpc("finish_extract_job", { p_job_id: job.job_id });
        if (result.state === "extracted") counts.extracted++; else counts.review++;
        // Counts, reasons and cost only; never email text or event titles.
        log("extract-events", requestId, "message_extracted", {
          message_id: job.message_id, state: result.state, reason: result.reason, model: result.model,
          candidates: result.candidates.length, rejected: result.rejected.map((r) => r.reason),
          cost_usd: Math.round(result.calls.reduce((n, c) => n + c.costUsd, 0) * 10000) / 10000,
        });
      } catch (e) {
        const { data: outcome } = await db.rpc("fail_extract_job", { p_job_id: job.job_id, p_message_id: job.message_id });
        if (outcome === "gave_up") counts.gave_up++; else counts.retry++;
        log("extract-events", requestId, "extract_error", { message_id: job.message_id, error: e instanceof Error ? e.message : "unknown", outcome });
      }
    }
  }
  log("extract-events", requestId, "batch_done", counts);
  return json({ ...counts, request_id: requestId });
});
