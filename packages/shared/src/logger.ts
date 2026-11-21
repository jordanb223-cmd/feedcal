export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

/**
 * Structured JSON logger. One line per entry. Never pass email bodies or
 * personal data in fields; log ids and hashes only (discipline rule 9).
 */
export function createLogger(base: LogFields = {}, sink: LogSink = (l) => console.log(l)): Logger {
  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Reuse a well-formed incoming request id, otherwise make a new one. */
export function requestIdFrom(incoming: string | null | undefined): string {
  if (incoming && REQUEST_ID_RE.test(incoming)) return incoming;
  return crypto.randomUUID();
}
