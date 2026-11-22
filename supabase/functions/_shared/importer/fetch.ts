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

/** True for addresses inside a private, local or reserved network (IPv4 and IPv6). */
export function privateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||   // this network, private, loopback, multicast/reserved
      (a === 100 && b >= 64 && b <= 127) ||                  // carrier-grade NAT
      (a === 169 && b === 254) ||                            // link-local (cloud metadata lives here)
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||      // IETF protocol assignments, documentation
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]!);
  return /^(fc|fd)/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

export type Resolver = (host: string) => Promise<string[]>;

/** Deno's DNS lookup (A and AAAA). Returns null where the runtime has no DNS API. */
export const denoResolver: Resolver | null = typeof Deno !== "undefined" && typeof Deno.resolveDns === "function"
  ? async (host) => {
    const out: string[] = [];
    for (const t of ["A", "AAAA"] as const) {
      try {
        out.push(...(await Deno.resolveDns(host, t)) as string[]);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) continue;   // no records of this type
        throw new DnsUnavailable();                        // the runtime refused the lookup
      }
    }
    return out;
  }
  : null;

/** D51: a public name that points into a private network is refused (best effort: the fetch
 *  resolves the name again, so a name that changes its answer in between isn't fully covered). */
export class DnsUnavailable extends Error {}

async function checkResolves(host: string, resolve: Resolver | null): Promise<void> {
  if (!resolve) return;
  let ips: string[];
  try {
    ips = await resolve(host);
  } catch (e) {
    if (e instanceof DnsUnavailable) return;  // can't look it up here: the other rules still apply
    throw e;
  }
  if (ips.length === 0) throw new Error("not_found");
  if (ips.some(privateAddress)) throw new Error("not_allowed");
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

export async function fetchIcs(url: string, fetchImpl: typeof fetch = fetch, resolve: Resolver | null = denoResolver): Promise<string> {
  let next = url.replace(/^webcal:\/\//i, "https://");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedUrl(next)) throw new Error("not_allowed");
    await checkResolves(new URL(next).hostname, resolve);
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
