export interface DbProbe {
  reachable: boolean;
  latency_ms: number | null;
}

/**
 * Calls the public.health_check() RPC with the anon key. The function returns
 * only `true` and touches no tables, so anon access reveals nothing.
 */
export async function probeDatabase(
  url: string,
  anonKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<DbProbe> {
  if (!anonKey) return { reachable: false, latency_ms: null };
  const started = Date.now();
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/rest/v1/rpc/health_check`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, latency_ms: null };
    const body: unknown = await res.json();
    return body === true
      ? { reachable: true, latency_ms: Date.now() - started }
      : { reachable: false, latency_ms: null };
  } catch {
    return { reachable: false, latency_ms: null };
  }
}
