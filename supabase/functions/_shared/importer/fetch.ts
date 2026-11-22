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
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|svc|cluster\.local)$/.test(host)) return false; // D60: + Kubernetes names
  if (u.port && !["443", "8443"].includes(u.port)) return false;
  return true;
}

function privateV4(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||   // this network, private, loopback, multicast/reserved
    (a === 100 && b >= 64 && b <= 127) ||                  // carrier-grade NAT
    (a === 169 && b === 254) ||                            // link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||      // IETF protocol assignments, documentation
    (a === 192 && b === 88 && c === 99) ||                 // 6to4 relay (D60)
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

/** Parses an IPv6 address (any notation, optional zone, optional dotted IPv4 tail) into 16 bytes. */
export function ipv6Bytes(raw: string): number[] | null {
  let s = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (tail) {
    const parts = tail.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    s = s.slice(0, tail.index) + ((parts[0]! << 8) | parts[1]!).toString(16) + ":" + ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  return bytes.length === 16 ? bytes : null;
}

/** True for addresses inside a private, local or reserved network (IPv4 and IPv6). D60: IPv6 is
 *  parsed, IPv4 hidden inside IPv6 (mapped, compatible, NAT64, 6to4) is checked, and anything
 *  that can't be read is treated as private. */
export function privateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const n = v4.slice(1).map(Number);
    return n.some((x) => x > 255) || privateV4(n[0]!, n[1]!, n[2]!);
  }
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const embedded = (at: number) => privateV4(b[at]!, b[at + 1]!, b[at + 2]!);
  if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return true;                                     // :: and ::1
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12);                          // ::ffff:a.b.c.d
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return embedded(12);           // ::ffff:0:a.b.c.d
  if (zeros(0, 12)) return true;                                                                      // ::a.b.c.d (deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {                            // 64:ff9b::/96, 64:ff9b:1::/48
    return !(zeros(4, 12)) || embedded(12);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2);                                             // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;                  // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;                  // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true;                                     // discard-only
  if ((b[0]! & 0xfe) === 0xfc) return true;                                                           // unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) >= 0x80) return true;                                           // link-local, site-local
  return b[0] === 0xff;                                                                               // multicast
}

export type Resolver = (host: string) => Promise<string[]>;

/** Deno's DNS lookup (A and AAAA). Returns null where the runtime has no DNS API. */
export const denoResolver: Resolver | null = typeof Deno !== "undefined" && typeof Deno.resolveDns === "function"
  ? async (host) => {
    const out: string[] = [];
    let unsupported = 0;
    for (const t of ["A", "AAAA"] as const) {
      try {
        out.push(...(await Deno.resolveDns(host, t)) as string[]);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) continue;          // no records of this type
        // D60: only a runtime that can't look names up at all skips the check. Any other error
        // (a server failure, a timeout) refuses: a name could fail one lookup on purpose while
        // its other answer points inside a network.
        if (e instanceof Deno.errors.PermissionDenied || e instanceof Deno.errors.NotSupported) { unsupported++; continue; }
        throw new Error("dns_failed");
      }
    }
    if (unsupported === 2) throw new DnsUnavailable();
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
      headers: { "user-agent": "Calantern-Importer/1.0", accept: "text/calendar" },
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
