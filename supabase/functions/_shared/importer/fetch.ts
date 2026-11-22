// D48: fetching a calendar link someone pasted. Organizers can now choose the link, so the fetch
// refuses addresses that point inside a network, checks every redirect the same way, and stops
// reading at the size limit instead of after it.
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** True for a public https URL with a real domain name (no IP numbers, no internal-only names). */
export function allowedUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(host)) return false; // a domain ending in letters: no IPv4/IPv6 literals
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) return false;
  if (u.port && !["443", "8443"].includes(u.port)) return false;
  return true;
}

async function readCapped(res: Response): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("too_large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("too_large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function fetchIcs(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let next = url.replace(/^webcal:\/\//i, "https://");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedUrl(next)) throw new Error("not_allowed");
    const res = await fetchImpl(next, {
      signal: AbortSignal.timeout(15_000), redirect: "manual",
      headers: { "user-agent": "Feedcal-Importer/1.0", accept: "text/calendar" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new Error(`http_${res.status}`);
      next = new URL(loc, next).toString();
      continue;
    }
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = await readCapped(res);
    if (!body.includes("BEGIN:VCALENDAR")) throw new Error("not_ics");
    return body;
  }
  throw new Error("too_many_redirects");
}
