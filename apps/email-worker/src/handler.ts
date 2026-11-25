import { createLogger, type LogSink } from "@feedcal/shared";

/** What the Worker needs from Cloudflare's ForwardableEmailMessage. */
export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly rawSize: number;
  readonly raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

export interface WorkerEnv {
  /** Public project URL (not secret). The Worker never holds the service-role key. */
  SUPABASE_URL: string;
  /** Shared with the ingest Edge Functions. */
  INGEST_HMAC_SECRET: string;
}

export interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
  sink?: LogSink;
}

export const MAX_BYTES = 20 * 1024 * 1024;
const ADDRESS = /^feed-[a-z2-7]{20}$/i;

/** Bounce text the sender sees. Plain English, what happened and what to do. */
export const REASONS: Record<string, string> = {
  unknown_address: "This Bumpdraft address doesn't exist. Please check the address on the calendar's email setup page.",
  too_large: "This email is larger than 20 MB, Bumpdraft's limit. Please send the schedule as a smaller file or a link.",
  too_many_attachments: "This email has more than 20 attachments, Bumpdraft's limit. Please send the schedule on its own.",
  daily_limit: "This calendar has received 50 emails today, its daily limit. Please send it again tomorrow.",
};

/** A problem on our side. Thrown, not bounced, so the sending server can retry (D26). */
export class TemporaryFailure extends Error {
  override name = "TemporaryFailure";
}

const enc = new TextEncoder();

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Delivers one email: ask ingest-start for a ticket, upload the raw bytes to the private bucket
 * with the one-time token, then ask ingest-commit to record it. No parsing happens here.
 * Logs a request id, sizes and outcomes; never addresses or content.
 */
export async function handleEmail(message: InboundMessage, env: WorkerEnv, deps: Deps = {}): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = createLogger({ service: "email-worker", request_id: crypto.randomUUID() }, deps.sink);
  const reject = (key: string) => {
    log.info("email_rejected", { reason: key, bytes: message.rawSize });
    message.setReject(REASONS[key] ?? REASONS.unknown_address ?? "Rejected.");
  };

  const [local] = message.to.split("@");
  if (!local || !ADDRESS.test(local)) return reject("unknown_address");
  if (message.rawSize > MAX_BYTES) return reject("too_large");
  if (!env.SUPABASE_URL || !env.INGEST_HMAC_SECRET) throw new TemporaryFailure("Worker is not configured");

  const functions = `${env.SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;
  const call = async (name: string, payload: unknown): Promise<Record<string, unknown>> => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const res = await doFetch(`${functions}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feedcal-timestamp": timestamp, "x-feedcal-signature": await sign(env.INGEST_HMAC_SECRET, timestamp, body) },
      body,
    });
    if (!res.ok) throw new TemporaryFailure(`${name} answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const start = await call("ingest-start", { to: message.to.toLowerCase(), bytes: message.rawSize });
  if (start.ok !== true) {
    if (typeof start.reject === "string" && start.reject in REASONS) return reject(start.reject);
    throw new TemporaryFailure(`ingest-start: ${String(start.reject)}`);
  }
  const { ticket, path, token } = start as { ticket: string; path: string; token: string };

  const raw = await new Response(message.raw).arrayBuffer();
  const upload = await doFetch(
    `${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/upload/sign/inbound-raw/${path}?token=${encodeURIComponent(token)}`,
    { method: "PUT", headers: { "content-type": "message/rfc822" }, body: raw },
  );
  if (!upload.ok) throw new TemporaryFailure(`upload answered ${upload.status}`);

  const commit = await call("ingest-commit", { ticket, path });
  if (commit.ok !== true) {
    if (typeof commit.reject === "string" && commit.reject in REASONS) return reject(commit.reject);
    throw new TemporaryFailure(`ingest-commit: ${String(commit.reject)}`);
  }
  log.info("email_accepted", { ticket, outcome: String(commit.outcome), bytes: raw.byteLength });
}
