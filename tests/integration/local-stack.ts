// Safety guard (D57): integration and load tests delete and rewrite data, so they only ever run
// against the local Supabase stack on this computer. Every test gets its addresses and keys from
// here; anything that isn't localhost stops the run before a client is created.
import { execFileSync } from "node:child_process";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Throws unless the stack's API and database addresses are on this computer. Prints hosts only, never URLs (they hold passwords). */
export function assertLocalStack(s: Record<string, string>): Record<string, string> {
  if (!s.API_URL) throw new Error("Local Supabase stack isn't running (no API_URL). Start it with `npm run db:start`.");
  for (const key of ["API_URL", "DB_URL"]) {
    const value = s[key];
    if (value !== undefined && !isLocalUrl(value)) {
      let host = "an unreadable address";
      try { host = new URL(value).hostname; } catch { /* keep the generic text */ }
      throw new Error(`REFUSING TO RUN: ${key} points at ${host}, not this computer. These tests DELETE and rewrite data; they only run against the local stack.`);
    }
  }
  return s;
}

/** The local stack's addresses and demo keys, checked to be local. */
export function localStatus(): Record<string, string> {
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return assertLocalStack(JSON.parse(out) as Record<string, string>);
}
