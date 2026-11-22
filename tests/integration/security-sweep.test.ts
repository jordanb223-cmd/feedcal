// D60: the security sweep, kept as a permanent test. A throwaway victim (Carol) gets three feeds,
// a trusted sender, emails, an attachment and events; then strangers attack every route and every
// database function, forms are sent with bad tokens, and stored text is filled with HTML payloads.
// Each "nothing got through" check is paired with a run as Carol, which must trip the same detector.
//   npm run test:integration   (needs the local stack; Carol is deleted afterwards)
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@feedcal/shared";
import { createApp } from "../../apps/web/src/app.js";
import type { Bindings } from "../../apps/web/src/env.js";
import type { Supa } from "../../apps/web/src/types.js";
import { localStatus } from "./local-stack.js";

const enabled = process.env.FEEDCAL_INTEGRATION === "1";
const BASE = "http://localhost:8788";
const sql = (q: string) => execFileSync("docker", ["exec", "-i", "supabase_db_feedcal", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-F", "|", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryUpdate = (q: string) => { try { sql(q); return true; } catch { return false; } };
const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";

const CAROL = "33333333-3333-4333-8333-333333333333";
const F = { pub: "cafe0000-0000-4000-8000-000000000001", unl: "cafe0000-0000-4000-8000-000000000002", priv: "cafe0000-0000-4000-8000-000000000003" };
const SRC = "cafe0000-0000-4000-8000-0000000000a1";
const MSG = ["cafe0000-0000-4000-8000-0000000000b1", "cafe0000-0000-4000-8000-0000000000b2"];
const ATT = "cafe0000-0000-4000-8000-0000000000c1";
const EV = ["cafe0000-0000-4000-8000-0000000000d1", "cafe0000-0000-4000-8000-0000000000d2"];
const BOB_FEED = "bbbbbbbb-0000-4000-8000-000000000001";
const FEEDS = `('${F.pub}','${F.unl}','${F.priv}')`;
const SECRETS = ["Carol Private Plans", "Draft: secret recital", "carol-office@sweep.example.test"];

function createCarol() {
  sql(`delete from auth.users where id = '${CAROL}'`);
  sql(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, reauthentication_token, phone_change, phone_change_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('${CAROL}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol-sweep@example.test', '', now(), '', '', '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}', '{}', now(), now())`);
  sql(`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values ('${CAROL}', '${CAROL}', '{"sub":"${CAROL}","email":"carol-sweep@example.test","email_verified":true}', 'email', now(), now(), now())`);
  sql(`insert into public.profiles (id, display_name) values ('${CAROL}', 'Carol Sweep') on conflict (id) do update set display_name = excluded.display_name`);
  sql(`insert into public.feeds (id, owner_id, name, slug, description, category, zip_code, visibility) values
    ('${F.pub}', '${CAROL}', 'Carol Public Class', 'carol-public-class', 'Public calendar.', 'school', '95818', 'public'),
    ('${F.unl}', '${CAROL}', 'Carol Unlisted Team', 'carol-unlisted-team', 'Unlisted.', 'sports', '95818', 'unlisted'),
    ('${F.priv}', '${CAROL}', '${SECRETS[0]}', 'carol-private-plans', null, null, null, 'private')`);
  sql(`insert into public.sources (id, feed_id, sender_email, sender_domain, trusted) values ('${SRC}', '${F.pub}', '${SECRETS[2]}', 'sweep.example.test', true)`);
  sql(`insert into public.messages (id, feed_id, source_id, message_id_header, sender, subject, status) values
    ('${MSG[0]}', '${F.pub}', '${SRC}', '<sweep-1@sweep.example.test>', '${SECRETS[2]}', 'Sweep newsletter', 'extracted'),
    ('${MSG[1]}', '${F.priv}', null, '<sweep-2@sweep.example.test>', 'someone@sweep.example.test', 'Private note', 'extracted')`);
  sql(`insert into public.attachments (id, message_id, filename, mime, bytes, pages, chosen, status) values ('${ATT}', '${MSG[0]}', 'sweep.pdf', 'application/pdf', 1000, 1, true, 'text_layer')`);
  sql(`insert into public.events (id, feed_id, title, starts_at, timezone, status, confidence, source_message_id, evidence_quote, published) values
    ('${EV[0]}', '${F.pub}', 'Sweep concert', now() + interval '5 days', 'America/Los_Angeles', 'confirmed', 0.95, '${MSG[0]}', 'Sweep concert', true),
    ('${EV[1]}', '${F.priv}', '${SECRETS[1]}', now() + interval '6 days', 'America/Los_Angeles', 'tentative', 0.6, '${MSG[1]}', 'secret recital', false)`);
}
const snapshot = () => sql(`select md5(coalesce(string_agg(t, '|' order by t), '')) from (
  select 'f'||f::text t from public.feeds f where id in ${FEEDS} union all select 'e'||e::text from public.events e where feed_id in ${FEEDS}
  union all select 's'||s::text from public.sources s where feed_id in ${FEEDS} union all select 'm'||m::text from public.messages m where feed_id in ${FEEDS}
  union all select 'ed'||x::text from public.feed_editors x where feed_id in ${FEEDS} union all select 'a'||a::text from public.attachments a where id = '${ATT}'
  union all select 'p'||p::text from public.profiles p where id = '${CAROL}') z`);

type Req = (path: string, init?: RequestInit) => Promise<Response>;
let local: { url: string; anon: string; service: string };
async function client(email: string | null): Promise<SupabaseClient<Database>> {
  const c = createClient<Database>(local.url, local.anon, { auth: { persistSession: false } });
  if (email) {
    const admin = createClient<Database>(local.url, local.service, { auth: { persistSession: false } });
    const { data } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const { error } = await c.auth.verifyOtp({ token_hash: data.properties?.hashed_token ?? "", type: "magiclink" });
    if (error) throw new Error(`sign-in failed for ${email}`);
  }
  return c;
}
function web(c: SupabaseClient<Database>): Req {
  const app = createApp({ version: "it", commit: "it", supabase: () => c as unknown as Supa, logSink: () => {} });
  const env: Bindings = { ENVIRONMENT: "local", SUPABASE_URL: local.url, SUPABASE_ANON_KEY: local.anon };
  return (path, init = {}) => Promise.resolve(app.request(`${BASE}${path}`, init, env));
}
async function csrf(req: Req, page: string) {
  const res = await req(page);
  return { cookie: /feedcal_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "", token: /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "" };
}

const GETS = ["/account", "/account/export", "/account/export/:file", "/account/support", "/admin", "/c/:slug", "/c/:slug/go/google", "/c/:slug/report", "/feeds", "/feeds/:id",
  "/feeds/:id/email", "/feeds/:id/events/:eid", "/feeds/:id/events/new", "/feeds/:id/flyer", "/feeds/:id/gmail", "/feeds/:id/link", "/feeds/:id/milestones/10", "/feeds/:id/settings",
  "/feeds/:id/setup", "/feeds/:id/share", "/report/:uid", "/near/95818", "/directory", "/supporters", "/sitemap.xml"];
const POSTS = ["/c/:slug/copied", "/c/:slug/report", "/feeds/:id/attachments/:att/choose", "/feeds/:id/attachments/:att/never", "/feeds/:id/delete", "/feeds/:id/events",
  "/feeds/:id/events/:eid", "/feeds/:id/events/:eid/cancel", "/feeds/:id/gmail/confirm", "/feeds/:id/gmail/connect", "/feeds/:id/gmail/disconnect", "/feeds/:id/gmail/interval",
  "/feeds/:id/gmail/look-back", "/feeds/:id/gmail/review", "/feeds/:id/gmail/search", "/feeds/:id/import", "/feeds/:id/import/stop", "/feeds/:id/messages/:msg",
  "/feeds/:id/rotate-intake", "/feeds/:id/rotate-token", "/feeds/:id/senders/:src", "/feeds/:id/senders/:src/large", "/feeds/:id/settings", "/feeds/:id/verify", "/report/:uid",
  "/undo/:eid", "/admin/alert-drill", "/admin/mfa", "/account/support/link", "/account/support/listing"];
const FIELDS = { name: "pwned", title: "pwned", description: "pwned", location: "pwned", date: "2026-12-24", start_date: "2026-12-24", time: "09:00", all_day: "on", visibility: "public",
  category: "school", zip: "95818", zip_code: "95818", timezone: "UTC", url: "https://example.com/x.ics", mode: "daily", confirm: "yes", action: "publish", decision: "trust", interval: "1",
  look_back: "on", query: "from:x", email: "evil@example.test", kind: "wrong_details", details: "pwned", choice: "approve", listed: "on", trusted: "true", status: "confirmed" };
function paths(): { path: string; post: boolean }[] {
  const out = new Map<string, boolean>();
  const uid = encodeURIComponent(`${EV[1]}@feedcal.app`);
  for (const feed of [F.pub, F.unl, F.priv, BOB_FEED]) for (const eid of EV) for (const msg of MSG) for (const [list, post] of [[GETS, false], [POSTS, true]] as const) for (const r of list) {
    out.set(r.replace(":id", feed).replace(":eid", eid).replace(":msg", msg).replace(":src", SRC).replace(":att", ATT).replace(":uid", uid).replace(":slug", "carol-private-plans")
      .replace(":file", `${F.priv}.ics`), post);
  }
  return [...out].map(([path, post]) => ({ path, post }));
}
async function sweep(who: string, req: Req, csrfPage: string, mode: "valid" | "missing" | "wrong" | "crosssite" = "valid") {
  const { cookie, token } = await csrf(req, csrfPage);
  const sent = mode === "missing" ? "" : mode === "wrong" ? "x".repeat(43) : token;
  const leaks: string[] = []; const writes: string[] = []; const errors: string[] = [];
  for (const { path, post } of paths()) {
    const before = post ? snapshot() : "";
    const res = await req(path, post
      ? { method: "POST", body: new URLSearchParams({ ...FIELDS, csrf: sent }), headers: { "content-type": "application/x-www-form-urlencoded", origin: mode === "crosssite" ? "https://evil.example" : BASE, cookie: `feedcal_csrf=${cookie}` } }
      : { headers: { cookie: `feedcal_csrf=${cookie}` } });
    const body = await res.text();
    for (const s of SECRETS) if (body.includes(s)) leaks.push(`${who} ${post ? "POST" : "GET"} ${path} [${res.status}] shows "${s}"`);
    if (res.status >= 500) errors.push(`${who} ${post ? "POST" : "GET"} ${path} -> ${res.status}`);
    if (post && snapshot() !== before) writes.push(`${who} POST ${path} [${res.status}] changed Carol's data`);
  }
  return { leaks, writes, errors };
}

describe.skipIf(!enabled)("security sweep (D60)", () => {
  let bob: Req; let anon: Req; let carol: Req;
  let bobDb: SupabaseClient<Database>; let anonDb: SupabaseClient<Database>; let carolDb: SupabaseClient<Database>;
  beforeAll(async () => {
    const s = localStatus(); local = { url: s.API_URL ?? "", anon: s.ANON_KEY ?? "", service: s.SERVICE_ROLE_KEY ?? "" };
    createCarol();
    [bobDb, anonDb, carolDb] = await Promise.all([client("bob@example.test"), client(null), client("carol-sweep@example.test")]);
    [bob, anon, carol] = [web(bobDb), web(anonDb), web(carolDb)];
  }, 60_000);
  afterAll(() => { sql(`delete from auth.users where id = '${CAROL}'`); });
  // Tests that change Carol's data start from a fresh Carol (deleting her ends her session too).
  async function freshCarol() { createCarol(); carolDb = await client("carol-sweep@example.test"); carol = web(carolDb); }

  it("strangers can't read or change Carol's data through any route", async () => {
    for (const [who, req, page] of [["bob", bob, "/account"], ["anon", anon, "/login"]] as const) {
      const r = await sweep(who, req, page);
      expect(r.leaks).toEqual([]); expect(r.writes).toEqual([]); expect(r.errors).toEqual([]);
    }
  }, 600_000);

  it("Carol's own forms refuse a missing, wrong or cross-site token", async () => {
    for (const mode of ["missing", "wrong", "crosssite"] as const) expect((await sweep("carol", carol, "/account", mode)).writes).toEqual([]);
  }, 600_000);

  it("strangers can't reach Carol's data by calling the database directly", async () => {
    const fns = sql(`select p.proname || '|' || pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`).split("\n")
      .map((l) => { const [name, args] = l.split("|"); return { name: name ?? "", args: (args ?? "").split(", ").filter(Boolean).map((a) => a.split(" ")) }; })
      .filter((f) => !["delete_my_account", "request_account_deletion", "sign_out_everywhere"].includes(f.name));
    const ids = [...Object.values(F), SRC, ...MSG, ATT, ...EV, CAROL];
    const value = (t: string, id: string, n: number): unknown => t === "uuid" ? id : /^(int|bigint|numeric|smallint)/.test(t) ? 1 : t === "boolean" ? true : t.startsWith("json") ? {}
      : t.endsWith("[]") ? [] : t === "text" ? ["carol-private-plans", "x", "' or 1=1--", "%", id][n % 5] : t.includes("time") ? "2026-12-01T00:00:00Z" : "x";
    const run = async (who: string, db: SupabaseClient<Database>) => {
      const found: string[] = [];
      for (const fn of fns) for (let n = 0; n < ids.length; n++) {
        const args: Record<string, unknown> = {}; for (const [a, ...t] of fn.args) args[a ?? ""] = value(t.join(" "), ids[n] ?? "", n);
        const before = snapshot();
        const { data } = await (db.rpc as unknown as (f: string, a: unknown) => Promise<{ data: unknown }>)(fn.name, args);
        const text = JSON.stringify(data ?? "");
        for (const s of SECRETS) if (text.includes(s)) found.push(`${who} ${fn.name} returned "${s}"`);
        if (snapshot() !== before) found.push(`${who} ${fn.name}(${JSON.stringify(args).slice(0, 80)}) changed Carol's data`);
        if (fn.args.every(([, t]) => t !== "uuid") && n >= 4) break;
      }
      return found;
    };
    await freshCarol();
    expect(await run("anon", anonDb)).toEqual([]);
    expect(await run("bob", bobDb)).toEqual([]);
    expect((await run("carol", carolDb)).length, "the detector must see Carol's own data").toBeGreaterThan(0);
  }, 900_000);

  it("text stored anywhere never renders as live HTML", async () => {
    await freshCarol();
    const PAYLOADS = (col: string) => [`"><x-canary f=${col}>`, `'><x-canary f=${col}>`, `" x-canary="${col}`, `' x-canary='${col}`, `</textarea></script></title></style><x-canary f=${col}>`,
      `<img src=x onerror=x-canary-${col}>`, `<svg/onload=x-canary-${col}>`, `<!--x-canary-->`, `]]><x-canary f=${col}>`, `javascript:x-canary-${col}`];
    const COLS: [string, string, string][] = [["feeds", "name", `id in ${FEEDS}`], ["feeds", "description", `id in ${FEEDS}`], ["feeds", "imported_source_name", `id in ${FEEDS}`],
      ["feeds", "hidden_reason", `id in ${FEEDS}`], ["events", "title", `feed_id in ${FEEDS}`], ["events", "description", `feed_id in ${FEEDS}`], ["events", "location", `feed_id in ${FEEDS}`],
      ["events", "evidence_quote", `feed_id in ${FEEDS}`], ["sources", "sender_email", `id = '${SRC}'`], ["sources", "sender_domain", `id = '${SRC}'`], ["messages", "sender", `feed_id in ${FEEDS}`],
      ["messages", "subject", `feed_id in ${FEEDS}`], ["messages", "original_sender", `feed_id in ${FEEDS}`], ["messages", "original_subject", `feed_id in ${FEEDS}`],
      ["messages", "clean_text", `feed_id in ${FEEDS}`], ["attachments", "filename", `id = '${ATT}'`], ["profiles", "display_name", `id = '${CAROL}'`]];
    const DETECT = [/<x-canary/i, /<img src=x onerror/i, /<svg\/onload/i, /" x-canary="/, /' x-canary='/, /(href|src|action)\s*=\s*["']?\s*javascript:/i, /<!--x-canary-->/];
    const pages: [string, Req][] = [];
    for (const f of Object.values(F)) for (const p of ["", "/settings", "/setup", "/share", "/flyer", "/flyer?half=1", "/email", "/gmail", "/link", "/events/new", "/milestones/10"]) pages.push([`/feeds/${f}${p}`, carol]);
    for (const e of EV) pages.push([`/feeds/${F.pub}/events/${e}`, carol], [`/feeds/${F.priv}/events/${e}`, carol]);
    for (const p of ["/feeds", "/account", "/account/support", "/directory", "/near/95818", "/supporters", "/c/carol-public-class", "/c/carol-unlisted-team", "/c/carol-public-class/report"]) pages.push([p, carol], [p, anon]);
    pages.push([`/report/${encodeURIComponent(`${EV[0]}@feedcal.app`)}`, anon]);
    const hits: string[] = [];
    for (let round = 0; round < 10; round++) {
      for (const [t, c, where] of COLS) tryUpdate(`update public.${t} set ${c} = ${lit(PAYLOADS(`${t}.${c}`)[round] ?? "")} where ${where}`);
      tryUpdate(`update public.feeds set import_url = 'javascript:alert(1)//x-canary' where id = '${F.pub}'`);
      for (const [path, req] of pages) {
        const res = await req(path);
        if (!(res.headers.get("content-type") ?? "").includes("text/html")) continue;
        // Search engines' JSON block: JSON, with "<" escaped, in a script that never runs.
        const body = (await res.text()).replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
        for (const re of DETECT) if (re.test(body)) hits.push(`round ${round} ${path}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  }, 900_000);

  it("the web detectors trip when Carol uses her own valid token", async () => {
    await freshCarol();
    const r = await sweep("carol", carol, "/account");
    expect(r.leaks.length).toBeGreaterThan(0);
    expect(r.writes.length).toBeGreaterThan(0);
  }, 600_000);
});
