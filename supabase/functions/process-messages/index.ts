// Edge Function: Phase 7 consumer. Claims queued emails, parses them, stores real attachments
// in the private "attachments" bucket, and records the result (D28). Run every minute by pg_cron.
// It only acts on jobs the database queued, so a stranger calling it changes nothing.
import { parseMessage } from "../_shared/parse/parse.ts";
import { admin, carriesUser, json, log, notScheduler } from "../_shared/http.ts";

const BATCH = 5;
const TIME_BUDGET_MS = 100_000; // stay well inside the Edge Function wall-clock limit

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (carriesUser(req)) return notScheduler();
  const db = admin();
  const started = Date.now();
  const counts = { parsed: 0, ignored: 0, skipped: 0, retry: 0, failed: 0 };

  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: jobs, error } = await db.rpc("claim_process_jobs", { p_limit: BATCH, p_visibility_seconds: 180 });
    if (error) return json({ error: "Try again later." }, 503);
    if (!jobs || jobs.length === 0) break;

    for (const job of jobs as { job_id: number; message_id: string | null; feed_id: string | null; storage_path: string | null; received_at: string | null }[]) {
      if (!job.message_id || !job.storage_path || !job.feed_id) {
        // The message expired or was deleted while queued.
        await db.rpc("finish_process_job", { p_job_id: job.job_id });
        counts.skipped++;
        continue;
      }
      try {
        const raw = await db.storage.from("inbound-raw").download(job.storage_path);
        if (raw.error || !raw.data) throw new Error("raw_missing");
        const { parsed, files } = await parseMessage(new Uint8Array(await raw.data.arrayBuffer()), { receivedAt: job.received_at ?? new Date().toISOString() });

        const stored = [];
        for (const f of files) {
          const path = `${job.feed_id}/${job.message_id}/${f.sha256}`;
          const up = await db.storage.from("attachments").upload(path, f.content, { contentType: f.mime, upsert: true });
          if (up.error) throw new Error("attachment_upload_failed");
          const meta = parsed.attachments.find((a) => a.sha256 === f.sha256);
          stored.push({ ...meta, storage_path: path });
        }
        const { data: status, error: recError } = await db.rpc("record_parsed_message", {
          p_message_id: job.message_id, p_parsed: parsed, p_attachments: stored,
        });
        if (recError) throw new Error("record_failed");
        await db.rpc("finish_process_job", { p_job_id: job.job_id });
        if (status === "ignored") counts.ignored++;
        else if (status === "parsed") counts.parsed++;
        else counts.skipped++;
        log("process-messages", requestId, "message_parsed", {
          message_id: job.message_id, status, attachments: stored.length, discarded: parsed.discarded.length,
          forward_depth: parsed.forwardDepth, body: parsed.bodySource, language: parsed.language, chars: parsed.cleanText.length,
        });
      } catch (e) {
        const { data: outcome } = await db.rpc("fail_process_job", { p_job_id: job.job_id, p_message_id: job.message_id });
        if (outcome === "failed") counts.failed++;
        else counts.retry++;
        log("process-messages", requestId, "message_parse_error", { message_id: job.message_id, error: e instanceof Error ? e.message : "unknown", outcome });
      }
    }
  }
  log("process-messages", requestId, "batch_done", counts);
  return json({ ...counts, request_id: requestId });
});
