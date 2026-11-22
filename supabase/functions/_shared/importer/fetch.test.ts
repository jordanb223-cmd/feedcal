import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { allowedUrl, DnsUnavailable, fetchIcs as realFetchIcs, MAX_BYTES, privateAddress, type Resolver } from "./fetch.ts";

// Tests never touch the network: no DNS lookup unless a test brings its own fake resolver.
const fetchIcs = (url: string, f: typeof fetch, resolve: Resolver | null = null) => realFetchIcs(url, f, resolve);

const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
const fake = (routes: Record<string, () => Response>) => (async (input: string | URL | Request) => {
  const key = String(input);
  const r = routes[key];
  if (!r) throw new Error(`unexpected fetch ${key}`);
  return r();
}) as typeof fetch;

Deno.test("only public https links with a real domain name", () => {
  for (const ok of ["https://calendar.google.com/calendar/ical/x/basic.ics", "https://school.example.org/cal.ics", "https://a.b.co:8443/x.ics"]) assertEquals(allowedUrl(ok), true, ok);
  for (const bad of ["http://school.example.org/cal.ics", "https://localhost/x.ics", "https://127.0.0.1/x.ics", "https://[::1]/x.ics",
    "https://10.0.0.5/x.ics", "https://printer.local/x.ics", "https://wiki.internal/x.ics", "https://user:pw@school.example.org/x.ics",
    "https://school.example.org:22/x.ics", "https://169.254.169.254/latest", "ftp://x.example.org/a", "not a url"]) assertEquals(allowedUrl(bad), false, bad);
});

Deno.test("webcal links are read as https", async () => {
  const body = await fetchIcs("webcal://school.example.org/cal.ics", fake({ "https://school.example.org/cal.ics": () => new Response(ICS) }));
  assertEquals(body, ICS);
});

Deno.test("every redirect is checked: a hop to an internal address is refused", async () => {
  await assertRejects(() => fetchIcs("https://school.example.org/cal.ics", fake({
    "https://school.example.org/cal.ics": () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } }),
  })), Error, "not_allowed");
  const ok = await fetchIcs("https://school.example.org/cal.ics", fake({
    "https://school.example.org/cal.ics": () => new Response(null, { status: 301, headers: { location: "/new.ics" } }),
    "https://school.example.org/new.ics": () => new Response(ICS),
  }));
  assertEquals(ok, ICS);
});

Deno.test("stops at 3 redirects", async () => {
  await assertRejects(() => fetchIcs("https://a.example.org/0", fake({
    "https://a.example.org/0": () => new Response(null, { status: 302, headers: { location: "/1" } }),
    "https://a.example.org/1": () => new Response(null, { status: 302, headers: { location: "/2" } }),
    "https://a.example.org/2": () => new Response(null, { status: 302, headers: { location: "/3" } }),
    "https://a.example.org/3": () => new Response(null, { status: 302, headers: { location: "/4" } }),
  })), Error, "too_many_redirects");
});

Deno.test("the size limit is enforced while reading, even without a length header", async () => {
  const big = new ReadableStream({ start(c) { const chunk = new Uint8Array(512 * 1024); for (let i = 0; i < 5; i++) c.enqueue(chunk); c.close(); } });
  await assertRejects(() => fetchIcs("https://a.example.org/big.ics", fake({ "https://a.example.org/big.ics": () => new Response(big) })), Error, "too_large");
  assertEquals(MAX_BYTES, 2 * 1024 * 1024);
});

Deno.test("a page that isn't a calendar is refused", async () => {
  await assertRejects(() => fetchIcs("https://a.example.org/x", fake({ "https://a.example.org/x": () => new Response("<html>hi</html>") })), Error, "not_ics");
});

Deno.test("private and internal addresses are recognised (D51)", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assertEquals(privateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "142.250.72.14", "172.32.0.1", "100.128.0.1", "2607:f8b0:4005:80b::200e"]) assertEquals(privateAddress(ip), false, ip);
});

Deno.test("a public-looking name that points into a private network is refused, also after a redirect (D51)", async () => {
  const resolve = async (host: string) => (host === "evil.example.org" ? ["169.254.169.254"] : ["93.184.216.34"]);
  await assertRejects(() => fetchIcs("https://evil.example.org/cal.ics", fake({}), resolve), Error, "not_allowed");
  await assertRejects(() => fetchIcs("https://school.example.org/cal.ics", fake({
    "https://school.example.org/cal.ics": () => new Response(null, { status: 302, headers: { location: "https://evil.example.org/x" } }),
  }), resolve), Error, "not_allowed");
  assertEquals(await fetchIcs("https://school.example.org/ok.ics", fake({ "https://school.example.org/ok.ics": () => new Response(ICS) }), resolve), ICS);
});

Deno.test("if the runtime won't do DNS lookups, imports still work under the other rules (D51)", async () => {
  const unavailable: Resolver = async () => { throw new DnsUnavailable(); };
  assertEquals(await fetchIcs("https://school.example.org/ok.ics", fake({ "https://school.example.org/ok.ics": () => new Response(ICS) }), unavailable), ICS);
});
