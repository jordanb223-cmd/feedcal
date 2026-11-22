// D60: generated request-forgery attacks on the calendar importer (URL forms, DNS answers, DNS
// failures, redirects, size). Nothing here touches the network: fetch and DNS are stand-ins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { allowedUrl, privateAddress, fetchIcs, denoResolver } from "./fetch.ts";
Deno.test("importer refuses every internal-network trick", async () => {
const out: string[] = [];
// 1) URL forms that must be refused before any lookup.
const HOSTS = ["127.0.0.1", "2130706433", "0177.0.0.1", "0x7f.1", "127.1", "0", "[::1]", "[::ffff:127.0.0.1]", "[0:0:0:0:0:0:0:1]", "169.254.169.254", "0xa9fea9fe", "[fd00::1]",
  "localhost", "LOCALHOST", "localhost.", "foo.localhost", "metadata.google.internal", "router.lan", "nas.home", "printer.local", "x.home.arpa", "intranet", "corp",
  "127。0。0。1", "１２７.０.０.１", "127%2e0%2e0%2e1", "%6c%6f%63%61%6c%68%6f%73%74", "loc­alhost", "ⓛⓞⓒⓐⓛⓗⓞⓢⓣ", "[::]", "0.0.0.0", "metadata", "kubernetes.default.svc"];
const FORMS = (h: string) => [`https://${h}/x.ics`, `https://${h}:443/x.ics`, `https://user@${h}/`, `https://good.example@${h}/`, `https://${h}#@good.example/`, `https://${h}\\@good.example/`,
  `http://${h}/`, `webcal://${h}/`, `HTTPS://${h}/`, `https:/${h}/`, `https:\\\\${h}\\`];
let urlCases = 0;
for (const h of HOSTS) for (const u of FORMS(h)) { urlCases++; if (allowedUrl(u)) out.push(`URL ALLOWED: ${u} (parsed host ${(() => { try { return new URL(u).hostname; } catch { return "?"; } })()})`); }
for (const u of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com", "data:text/calendar,BEGIN", "javascript:alert(1)", "https://example.com:22/", "https://example.com:6379/", "https://good.example:443@evil.example/"])
  { urlCases++; if (allowedUrl(u)) out.push(`URL ALLOWED: ${u}`); }
// 2) Addresses DNS could return.
const PRIVATE = ["0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.1", "127.255.255.255", "169.254.0.0", "169.254.169.254", "169.254.255.255",
  "172.16.0.0", "172.31.255.255", "192.0.0.0", "192.0.0.255", "192.0.2.1", "192.168.0.0", "192.168.255.255", "198.18.0.0", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1",
  "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.88.99.1",
  "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::ffff:0:a00:1", "::127.0.0.1", "::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::127.0.0.1",
  "64:ff9b:1::a00:1", "2002:a9fe:a9fe::", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "100::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "FE80::1", "::FFFF:127.0.0.1"];
const PUBLIC = ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.167.1.1", "198.17.255.255", "198.20.0.0", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888"];
for (const ip of PRIVATE) if (!privateAddress(ip)) out.push(`PRIVATE NOT CAUGHT: ${ip}`);
for (const ip of PUBLIC) if (privateAddress(ip)) out.push(`public wrongly blocked: ${ip}`);
// 3) DNS answer tricks through fetchIcs (fetch stubbed; reaching it = the connection would be made).
const reached: string[] = [];
const fakeFetch = (async (u: string) => { reached.push(u); return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { status: 200 }); }) as unknown as typeof fetch;
const tryFetch = async (label: string, url: string, resolver: ((h: string) => Promise<string[]>) | null, f = fakeFetch) => {
  const before = reached.length; let res = "ok";
  try { await fetchIcs(url, f, resolver); } catch (e) { res = String((e as Error).message); }
  return `${label}: ${reached.length > before ? "CONNECTED" : "refused"} (${res})`;
};
out.push(await tryFetch("name -> 169.254.169.254", "https://meta.evil.example/x.ics", async () => ["169.254.169.254"]));
out.push(await tryFetch("name -> public + private", "https://mix.evil.example/x.ics", async () => ["8.8.8.8", "10.0.0.1"]));
out.push(await tryFetch("name -> ::ffff:7f00:1 (hex mapped)", "https://hex.evil.example/x.ics", async () => ["::ffff:7f00:1"]));
out.push(await tryFetch("name -> 64:ff9b::a9fe:a9fe (NAT64)", "https://nat64.evil.example/x.ics", async () => ["64:ff9b::a9fe:a9fe"]));
// The real Deno resolver, with Deno.resolveDns stubbed: A answers private, AAAA fails with a server error.
const realResolve = Deno.resolveDns;
(Deno as unknown as { resolveDns: unknown }).resolveDns = async (_h: string, t: string) => { if (t === "A") return ["169.254.169.254"]; throw new Error("SERVFAIL"); };
out.push(await tryFetch("REAL resolver: A=private, AAAA=SERVFAIL", "https://servfail.evil.example/x.ics", denoResolver));
(Deno as unknown as { resolveDns: unknown }).resolveDns = async (_h: string, t: string) => { if (t === "AAAA") return ["::1"]; throw new Error("timeout"); };
out.push(await tryFetch("REAL resolver: A=timeout, AAAA=::1", "https://timeout.evil.example/x.ics", denoResolver));
(Deno as unknown as { resolveDns: unknown }).resolveDns = realResolve;
// 4) Redirect tricks.
const redirector = (to: string) => (async (u: string) => { reached.push(u); if (u.startsWith("https://start.")) return new Response(null, { status: 302, headers: { location: to } }); return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"); }) as unknown as typeof fetch;
const pub = async () => ["8.8.8.8"];
for (const to of ["https://169.254.169.254/", "http://good.example/", "//127.0.0.1/", "https://localhost/", "https://[::1]/", "file:///etc/passwd", "https://meta.evil.example/"]) {
  const resolver = async (h: string) => (h === "meta.evil.example" ? ["169.254.169.254"] : ["8.8.8.8"]);
  const before = reached.length; let r = "ok"; try { await fetchIcs("https://start.example/x.ics", redirector(to), resolver); } catch (e) { r = (e as Error).message; }
  const hops = reached.slice(before); out.push(`redirect -> ${to}: ${hops.length > 1 ? "FOLLOWED to " + hops[1] : "refused"} (${r})`);
}
const loop = (async (u: string) => { reached.push(u); return new Response(null, { status: 302, headers: { location: "https://start.example/again" } }); }) as unknown as typeof fetch;
{ let r = "ok"; try { await fetchIcs("https://start.example/x.ics", loop, pub); } catch (e) { r = (e as Error).message; } out.push(`redirect loop: ${r}`); }
// 5) Size: a body that lies about its length and never ends.
const endless = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)); } }), { headers: { "content-length": "10" } })) as unknown as typeof fetch;
{ const t0 = performance.now(); let r = "ok"; try { await fetchIcs("https://big.example/x.ics", endless, pub); } catch (e) { r = (e as Error).message; } out.push(`endless body: ${r} in ${(performance.now() - t0).toFixed(0)} ms`); }
  const bad = out.filter((l) => /ALLOWED|NOT CAUGHT|wrongly|CONNECTED|FOLLOWED/.test(l));
  assertEquals(bad, [], bad.join("\n"));
  assert(urlCases > 350, `only ${urlCases} URL forms`);
  assert(out.some((l) => l.startsWith("redirect loop: too_many_redirects")));
  assert(out.some((l) => l.startsWith("endless body: too_large")));
});
