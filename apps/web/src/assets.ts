// Phase 16 (D37): the site's one stylesheet and one script, served from this origin so the
// Content-Security-Policy can forbid every inline script. Paths carry a content hash, so they
// can be cached for a year and a deploy changes the URL.
import type { Context, Hono } from "hono";
import type { AppEnv } from "./types.js";

export const APP_CSS = `
.choice{border:0;padding:0;margin:0 0 .5rem;display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.choice legend{font-weight:600;margin-bottom:.5rem}
.choice label{display:flex;gap:.5rem;align-items:flex-start;border:2px solid #d8d8d3;border-radius:12px;padding:1rem;cursor:pointer;background:#fff}
.choice label:has(input:checked){border-color:#1d1d1b;background:#f0f0ec}
.choice input{margin-top:.25rem}
@media (max-width:28rem){.choice{grid-template-columns:1fr}}
.site{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:center;margin:0 0 1rem;font-size:.9375rem}
.site .brand{font-weight:700;margin-right:auto;text-decoration:none;color:inherit}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d1d1b;background:#f6f6f4}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem}
.card{background:#fff;border-radius:12px;padding:1.5rem;margin:0 0 1rem}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 1rem}
h2{font-size:1.25rem;line-height:1.3;margin:0 0 .75rem}
p{margin:0 0 1rem}
.muted{color:#4f4f4b}
label{display:block;font-weight:600;margin:0 0 .25rem}
input[type=email]{width:100%;font:inherit;padding:.75rem;border:2px solid #6b6b66;border-radius:8px}
button,.button{display:inline-block;font:inherit;font-weight:600;padding:.75rem 1.25rem;border-radius:8px;border:2px solid #1f5f3f;background:#1f5f3f;color:#fff;cursor:pointer;text-decoration:none}
button.secondary{background:#fff;color:#1f5f3f}
button.danger{background:#8a1c1c;border-color:#8a1c1c}
form{margin:0 0 1rem}
:focus-visible{outline:3px solid #1a4fd6;outline-offset:2px}
.error{background:#fdf1f1;color:#8a1c1c;border-left:4px solid #8a1c1c;padding:.75rem 1rem;border-radius:4px}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
.row{display:flex;flex-wrap:wrap;gap:.5rem}
.sep{text-align:center;margin:1rem 0}
a.button{margin:0 0 .5rem}
a.button.secondary{background:#fff;color:#1f5f3f}
.wide{display:block;width:100%;text-align:center}
.events{list-style:none;padding:0;margin:0}
.events li{padding:.75rem 0;border-top:1px solid #e3e3df}
.events li:first-child{border-top:0}
.when{display:block;font-size:.95rem;color:#4f4f4b}
details summary{cursor:pointer;font-weight:600;padding:.5rem 0}
textarea,input.copy,select.copy{width:100%;font:inherit;padding:.75rem;border:2px solid #6b6b66;border-radius:8px;background:#fff}
mark{background:#fff0a8;color:inherit;padding:0 .1em}
blockquote{margin:0 0 1rem}
.qr svg{width:12rem;height:12rem;display:block;margin:0 auto}
@media print{body{background:#fff}.no-print{display:none}.card{padding:0}}
`;

// Behaviour hooks are data attributes; no inline handlers anywhere (the CSP would block them).
//   data-copy="<input id>"  copy that input's value; data-count="<url>" also reports the tap
//   data-print              print the page
//   data-countdown="10"     remove this element after N seconds; [data-countdown-left] shows N
export const APP_JS = `"use strict";
document.addEventListener("click", async (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target) return;
  if (target.closest("[data-print]")) { window.print(); return; }
  const btn = target.closest("[data-copy]");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  if (!input) return;
  try { await navigator.clipboard.writeText(input.value); btn.textContent = "Copied"; }
  catch { input.select(); btn.textContent = "Press Ctrl+C or \u2318C"; }
  if (btn.dataset.count) fetch(btn.dataset.count, { method: "POST" }).catch(() => {});
});
for (const el of document.querySelectorAll("[data-countdown]")) {
  let n = Number(el.dataset.countdown) || 10;
  const left = el.querySelector("[data-countdown-left]");
  const timer = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(timer); el.remove(); }
    else if (left) left.textContent = "(" + n + ")";
  }, 1000);
}
`;

/** FNV-1a, enough to give each version of an asset its own URL. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Phase 18 (D38): "PWA first". A manifest and an icon so the site can be added to a phone's home
// screen. No service worker: calendars come from the calendar app, so there's nothing to cache.
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1d1d1b"/><rect x="12" y="16" width="40" height="36" rx="5" fill="#fff"/><rect x="12" y="16" width="40" height="10" rx="5" fill="#e8533f"/><rect x="20" y="10" width="5" height="12" rx="2" fill="#1d1d1b"/><rect x="39" y="10" width="5" height="12" rx="2" fill="#1d1d1b"/><path d="M22 39l7 7 13-14" fill="none" stroke="#1d1d1b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const MANIFEST = JSON.stringify({
  name: "Feedcal",
  short_name: "Feedcal",
  description: "Turn school and team emails into a calendar families can subscribe to.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f6f6f4",
  theme_color: "#1d1d1b",
  icons: [{ src: "/assets/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});

export const ASSET_PATHS = { css: `/assets/app.${shortHash(APP_CSS)}.css`, js: `/assets/app.${shortHash(APP_JS)}.js` } as const;

export function registerAssetRoutes(app: Hono<AppEnv>): void {
  const serve = (body: string, type: string) => (c: Context<AppEnv>) => {
    c.header("content-type", type);
    c.header("cache-control", "public, max-age=31536000, immutable");
    return c.body(body);
  };
  app.get(ASSET_PATHS.css, serve(APP_CSS, "text/css; charset=utf-8"));
  app.get(ASSET_PATHS.js, serve(APP_JS, "text/javascript; charset=utf-8"));
  app.get("/assets/icon.svg", (c) => {
    c.header("content-type", "image/svg+xml");
    c.header("cache-control", "public, max-age=86400");
    return c.body(ICON_SVG);
  });
  app.get("/manifest.webmanifest", (c) => {
    c.header("content-type", "application/manifest+json");
    c.header("cache-control", "public, max-age=86400");
    return c.body(MANIFEST);
  });
}
