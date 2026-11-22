// Phase 13: the public directory (D34). Queries run with the public (anon) key and NO session,
// so the database's anonymous rules decide what's visible: public feeds only, safe columns only.
import { createClient } from "@supabase/supabase-js";
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { z } from "zod";
import type { Database } from "@feedcal/shared";
import { originOf } from "./security.js";
import type { AppEnv, Supa } from "./types.js";
import { messagePage, publicLayout } from "./views.js";

export const DIRECTORY_CATEGORIES = ["school", "youth sports", "community", "faith", "library", "government", "venue/music", "other"] as const;
const Query = z.object({
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  zip: z.string().regex(/^\d{5}$/).optional().or(z.literal("").transform(() => undefined)),
  miles: z.coerce.number().refine((n) => [5, 10, 25].includes(n)).optional().catch(10),
  category: z.enum(DIRECTORY_CATEGORIES).optional().or(z.literal("").transform(() => undefined)).catch(undefined),
});
export interface DirectoryRow {
  slug: string; name: string; description: string | null; category: string | null; city: string | null; state: string | null;
  distance_miles: number | null; subscribers: number; last_updated_at: string; may_be_out_of_date: boolean; verified: boolean; imported_source_name: string | null;
}

export function anonSupabase(c: Context<AppEnv>): Supa {
  return createClient<Database>(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Supa;
}

function directoryPage(opts: { q?: string | undefined; zip?: string | undefined; miles: number; category?: string | undefined; rows: DirectoryRow[]; searched: boolean; unknownZip: boolean }) {
  const title = opts.zip ? `Calendars near ${opts.zip}` : "Find a calendar";
  return publicLayout(title, html`<div class="card">
  <h1>${title}</h1>
  <p class="muted">Public calendars from schools, teams, libraries and community groups. Subscribe once; they stay up to date.</p>
  <form method="get" action="/directory" role="search">
    <p><label for="q">Search</label><input class="copy" id="q" name="q" autocomplete="off" value="${opts.q ?? ""}" placeholder="Land Park soccer" dir="auto"></p>
    <div class="row">
      <p style="flex:1"><label for="zip">ZIP code</label><input class="copy" id="zip" name="zip" inputmode="numeric" autocomplete="postal-code" spellcheck="false" pattern="[0-9]{5}" value="${opts.zip ?? ""}"></p>
      <p style="flex:1"><label for="miles">Within</label><select class="copy" id="miles" name="miles">${[5, 10, 25].map((m) => html`<option value="${m}" ${opts.miles === m ? "selected" : ""}>${m} miles</option>`)}</select></p>
    </div>
    <p><label for="category">Kind</label><select class="copy" id="category" name="category"><option value="">All</option>${DIRECTORY_CATEGORIES.map((c) => html`<option value="${c}" ${opts.category === c ? "selected" : ""}>${c}</option>`)}</select></p>
    <button type="submit">Search</button>
  </form>
</div>
${opts.searched
  ? html`<div class="card">
  ${opts.unknownZip ? html`<p class="error" role="alert">We don't know that ZIP code yet.</p>` : ""}
  ${opts.rows.length === 0
    ? html`<p>No public calendars found. Try a wider distance or fewer words.</p>`
    : html`<ul class="events">${opts.rows.map((r) => html`<li>
      <a href="/c/${r.slug}"><strong dir="auto">${r.name}</strong></a>${r.verified ? html` <span title="Verified organizer">✓</span>` : ""}
      <span class="when">${[r.category, r.city ? `${r.city}${r.state ? `, ${r.state}` : ""}` : null, r.distance_miles === null ? null : `${r.distance_miles} mi`,
        r.imported_source_name ? `from ${r.imported_source_name}` : null].filter(Boolean).join(" · ")}</span>
      ${r.may_be_out_of_date ? html`<span class="when">May be out of date</span>` : ""}
      ${r.description ? html`<span class="when" dir="auto">${r.description.slice(0, 160)}</span>` : ""}
    </li>`)}</ul>`}
</div>`
  : ""}`);
}

export function registerDirectoryRoutes(app: Hono<AppEnv>, anon: (c: Context<AppEnv>) => Supa = anonSupabase): void {
  const search = async (c: Context<AppEnv>, zipFromPath?: string) => {
    const parsed = Query.safeParse({ ...c.req.query(), ...(zipFromPath ? { zip: zipFromPath } : {}) });
    const q = parsed.success ? parsed.data : { miles: 10 } as z.infer<typeof Query>;
    const miles = q.miles ?? 10;
    const searched = Boolean(q.q || q.zip || q.category);
    let rows: DirectoryRow[] = [];
    let unknownZip = false;
    if (searched) {
      const ip = c.req.header("cf-connecting-ip");
      if (ip) {
        // 60 searches a minute per address (D37).
        const { data: ok } = await anon(c).rpc("rate_check", { p_bucket: "search", p_client_ip: ip });
        if (ok !== true) {
          c.header("retry-after", "60");
          return c.html(messagePage("Slow down a little", "That's a lot of searches in a minute. Please wait a moment and try again."), 429);
        }
      }
      const { data, error } = await anon(c).rpc("directory_search", {
        ...(q.q ? { p_query: q.q } : {}), ...(q.zip ? { p_zip: q.zip } : {}), p_miles: miles, ...(q.category ? { p_category: q.category } : {}), p_limit: 30,
      });
      if (error) throw new Error("directory_search failed");
      rows = (data ?? []) as DirectoryRow[];
      if (q.zip && rows.length === 0) {
        const { data: z } = await anon(c).from("zip_codes").select("zip").eq("zip", q.zip).maybeSingle();
        unknownZip = !z;
      }
    }
    c.header("cache-control", "public, max-age=300");
    return c.html(directoryPage({ q: q.q, zip: q.zip, miles, category: q.category, rows, searched, unknownZip }));
  };
  app.get("/directory", (c) => search(c));
  app.get("/near/:zip", (c) => {
    const zip = c.req.param("zip");
    return /^\d{5}$/.test(zip) ? search(c, zip) : c.redirect("/directory", 302);
  });

  // Public feeds only (never unlisted or private) [Rev 3].
  app.get("/sitemap.xml", async (c) => {
    const { data } = await anon(c).from("feeds").select("slug, last_updated_at").eq("visibility", "public").order("last_updated_at", { ascending: false }).limit(5000);
    const origin = originOf(c);
    const urls = [`<url><loc>${origin}/directory</loc></url>`,
      ...(data ?? []).map((f) => `<url><loc>${origin}/c/${encodeURIComponent(f.slug)}</loc><lastmod>${f.last_updated_at.slice(0, 10)}</lastmod></url>`)];
    c.header("content-type", "application/xml; charset=utf-8");
    c.header("cache-control", "public, max-age=3600");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
  });

  app.get("/robots.txt", (c) => {
    c.header("cache-control", "public, max-age=86400");
    // Calendar files, account and feed-management pages are not for search engines.
    return c.text(`User-agent: *\nDisallow: /f/\nDisallow: /feeds\nDisallow: /account\nDisallow: /auth/\nDisallow: /report/\nAllow: /\nSitemap: ${originOf(c)}/sitemap.xml\n`);
  });
}
