import { createLogger, type LogSink } from "@feedcal/shared";

export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export const NOT_READY_REASON = "Feedcal is not accepting email yet. Please try again later.";

/**
 * Phase 1 stub: rejects all mail so nothing is stored before intake exists.
 * Phase 6 replaces this with ingest-start / upload / ingest-commit.
 * Logs only a request id and size; never addresses or content.
 */
export function handleEmail(message: InboundMessage, sink?: LogSink): void {
  const log = createLogger({ service: "email-worker", request_id: crypto.randomUUID() }, sink);
  log.info("email_rejected_not_ready", { bytes: message.rawSize });
  message.setReject(NOT_READY_REASON);
}
