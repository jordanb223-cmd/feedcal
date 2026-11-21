// Edge Function: Phase 8 consumer (D29). Claims messages from the "triage_message" queue, picks
// the pages worth reading (cheapest step first), stores them in attachment_pages, and hands the
// message to "extract_message". Run every minute by pg_cron. It only acts on queued jobs.
// Vision transcription runs only when ANTHROPIC_API_KEY is set; otherwise images wait.
import { claudeTranscriber } from "../_shared/triage/transcriber.ts";
import { type AttachmentIn, triageMessage } from "../_shared/triage/triage.ts";
import { admin, json, log } from "../_shared/http.ts";

const TIME_BUDGET_MS = 100_000;

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const db = admin();
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const transcriber = apiKey ? claudeTranscriber(apiKey) : undefined;
  const started = Date.now();
  const counts = { messages: 0, pages: 0, retry: 0, gave_up: 0 };

  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: jobs, error } = await db.rpc("claim_triage_jobs", { p_limit: 3, p_visibility_seconds: 300 });
    if (error) return json({ error: "Try again later." }, 503);
    if (!jobs || jobs.length === 0) break;

    for (const job of jobs as { job_id: number; message_id: string | null; feed_id: string | null; attachment_rule: unknown; attachments: AttachmentIn[] }[]) {
      if (!job.message_id || !job.feed_id) {
        await db.rpc("finish_triage_job", { p_job_id: job.job_id });
        continue;
      }
      const feedId = job.feed_id;
      try {
        const results = await triageMessage(job.attachments ?? [], job.attachment_rule, {
          transcriber,
          async readFile(path) {
            const file = await db.storage.from("attachments").download(path);
            if (file.error || !file.data) throw new Error("attachment_missing");
            return new Uint8Array(await file.data.arrayBuffer());
          },
          async quota(kind, wanted) {
            const { data, error: qError } = await db.rpc("take_quota", { p_feed_id: feedId, p_kind: kind, p_wanted: wanted });
            if (qError) throw new Error("quota_failed");
            return Number(data ?? 0);
          },
        });
        const { data: pages, error: recError } = await db.rpc("record_triage", { p_message_id: job.message_id, p_results: results });
        if (recError) throw new Error("record_failed");
        await db.rpc("finish_triage_job", { p_job_id: job.job_id });
        counts.messages++;
        counts.pages += Number(pages ?? 0);
        // Ids, stages, reasons and cost estimates only; never file names or text.
        log("triage-attachments", requestId, "message_triaged", {
          message_id: job.message_id,
          pages_for_ai: pages,
          attachments: results.map((r) => ({ id: r.id, status: r.status, stage: r.triage.stage, reason: r.triage.reason, kept: r.triage.keptPages?.length ?? 0, cost_usd: r.triage.costUsd ?? 0 })),
          vision: Boolean(transcriber),
        });
      } catch (e) {
        const { data: outcome } = await db.rpc("fail_triage_job", { p_job_id: job.job_id, p_message_id: job.message_id });
        if (outcome === "gave_up") counts.gave_up++; else counts.retry++;
        log("triage-attachments", requestId, "triage_error", { message_id: job.message_id, error: e instanceof Error ? e.message : "unknown", outcome });
      }
    }
  }
  log("triage-attachments", requestId, "batch_done", counts);
  return json({ ...counts, request_id: requestId });
});
