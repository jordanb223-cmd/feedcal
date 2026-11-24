// Phase 16 (D37): the site's one stylesheet and one script, served from this origin so the
// Content-Security-Policy can forbid every inline script. Paths carry a content hash, so they
// can be cached for a year and a deploy changes the URL.
import type { Context, Hono } from "hono";
import type { AppEnv } from "./types.js";

export const APP_CSS = `
/* Calantern, "Lantern paper" (DESIGN.md part 4). Tokens first; every colour pair below was
   computed for contrast: ink on paper 15.4:1, soft ink 6.4:1, accent text 5.2:1, white on accent 5.2:1. */
@font-face{font-family:"Young Serif";src:url(/fonts/young-serif-latin-400.woff2) format("woff2");font-weight:400;font-style:normal;font-display:swap}
:root{--paper:#f6efe2;--card:#fffaf0;--ink:#1c1813;--soft:#5e5546;--line:#e2d6bf;--field:#857a66;--accent:#c2410c;--accent-text:#b23a08;--mark:#fbd9a5;--danger:#8a1c1c;--ring:#1a4fd6;
  --radius:12px;--display:"Young Serif","Iowan Old Style","Palatino Linotype",Georgia,serif;--text:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:16px/1.5 var(--text);color:var(--ink);background:var(--paper)}
main{max-width:30rem;margin:0 auto;padding:1.25rem 1.25rem 2.5rem;overflow-wrap:anywhere}
a{color:inherit;text-underline-offset:.18em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
h1,h2,h3{font-family:var(--display);font-weight:400;text-wrap:balance}
h1{font-size:2rem;line-height:1.05;letter-spacing:-.015em;margin:0 0 .875rem}
h2{font-size:1.375rem;line-height:1.2;margin:0 0 .75rem}
h3{font-size:1.125rem;line-height:1.25;margin:0 0 .25rem}
p{margin:0 0 1rem}
ul,ol{margin:0 0 1rem;padding-left:1.25rem}
li{margin:0 0 .375rem}
code{font-size:.9375em;background:#efe6d3;border-radius:4px;padding:.05em .3em}
:focus-visible{outline:3px solid var(--ring);outline-offset:2px;border-radius:4px}
.muted{color:var(--soft)}
.skip{position:absolute;left:1rem;top:-3rem;background:var(--ink);color:var(--paper);padding:.5rem 1rem;border-radius:8px;z-index:10}
.skip:focus{top:1rem}

/* Site header and footer */
.site{display:flex;flex-wrap:wrap;gap:.25rem 1.125rem;align-items:center;margin:0 0 1.75rem;font-size:.9375rem}
.site .brand{font:400 1.3125rem/1 var(--display);letter-spacing:-.01em;margin-right:auto;text-decoration:none;display:inline-flex;align-items:center;gap:.4375rem}
.site .brand::before{content:"";width:.5625rem;height:.5625rem;border-radius:50%;background:var(--accent)}
.site a{padding:.6875rem 0;margin:-.6875rem 0}
footer{border-top:1px solid var(--line);margin-top:2rem;padding-top:1.25rem;font-size:.875rem;color:var(--soft)}
footer p{margin:0 0 .75rem}
footer nav{display:flex;flex-wrap:wrap;gap:.125rem 1.125rem}
footer nav a{padding:.375rem 0}
/* Calendar pages already carry the longer notes right above the footer; don't say it twice. */
main:has(.notes) footer>p:first-child{display:none}

/* Review page (D81): one card per email. What needs the owner is tinted; the rest is quiet. */
.status{font-size:1.0625rem;margin:0 0 1.25rem}
.mailcard{display:block;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);margin:0 0 1rem;overflow:hidden}
.mailcard>header{padding:1rem 1.25rem .875rem}
.mailcard h2{font-size:1.25rem;margin:0 0 .25rem}
.mailcard .from{font-size:.875rem;color:var(--soft);margin:0}
.mailcard .sum{margin:.625rem 0 0}
.part{border-top:1px solid var(--line);padding:.875rem 1.25rem}
.part>h3{font:700 .8125rem/1.2 system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:var(--soft);margin:0 0 .625rem}
.part.ask{background:#fff6e6}
.part.ask>h3{color:var(--accent-text)}
.part.ask .row{margin:0 0 .5rem}
.part.ask details{margin:.25rem 0 0}
.part.ask details[open]>summary{margin-bottom:.625rem}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:flex;gap:.625rem;align-items:baseline;padding:.3125rem 0}
.rows .tick{color:#2f6b3a;font-weight:700;flex-shrink:0}
.rows .t{flex:1;min-width:0}
.rows .d{display:block;font-size:.875rem;color:var(--soft)}
.rows a{font-size:.875rem;color:var(--soft)}
.q{font:400 1.1875rem/1.3 var(--display);margin:0 0 .25rem}
.qwhen{margin:0 0 .625rem}
.why{font-size:.875rem;color:var(--soft);margin:0 0 .875rem}
details.left{border-top:1px solid var(--line);padding:.75rem 1.25rem;font-size:.9375rem;color:var(--soft)}
details.left ul{margin:.5rem 0 0;padding-left:1.125rem}
details.mailcard.quiet>summary{display:flex;gap:.75rem;align-items:baseline;justify-content:space-between;padding:.75rem 1.25rem;cursor:pointer;list-style:none}
details.mailcard.quiet>summary::-webkit-details-marker{display:none}
details.mailcard.quiet .s{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.mailcard.quiet .from{white-space:nowrap}

/* Surfaces */
/* A page is open sections divided by a rule. Only the one main thing on a page gets a panel. */
.card{padding:1.5rem 0 .5rem;margin:0;border-top:1px solid var(--line)}
main>.card:first-of-type{border-top:0;padding-top:0}
.card.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:1.25rem;margin:0 0 1.25rem}
main>.card.panel:first-of-type{padding-top:1.25rem;border-top:1px solid var(--line)}
.card.panel+.card{border-top:0;padding-top:.5rem}
.two-up>.card.panel{padding-top:1.25rem}
.card.panel>:last-child,.card.panel>form:last-child{margin-bottom:0}
.kicker{display:block;font-size:.8125rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--accent-text);margin:0 0 .5rem}
.tag{font:700 .6875rem/1.6 var(--text);letter-spacing:.08em;text-transform:uppercase;color:var(--accent-text);border:1.5px solid var(--accent-text);border-radius:999px;padding:0 .5rem}
.error{background:#fbe9e4;color:var(--danger);border-left:4px solid var(--danger);padding:.75rem 1rem;border-radius:4px}
[role=status],main>.card[role=status]{background:#eef3e2;border:0;border-left:4px solid #5b7a2a;padding:.75rem 1rem;border-radius:4px;margin:0 0 1.25rem}
.card[role=status]>:last-child{margin-bottom:0}
.card[role=status]+.card{border-top:0;padding-top:0}
mark{background:var(--mark);color:inherit;padding:0 .15em}
blockquote{margin:0 0 1rem;border-left:3px solid var(--accent);padding-left:.75rem}

/* Buttons: one filled pill per screen; the rest are outlined or plain links */
button,.button{display:inline-block;font:inherit;font-weight:700;line-height:1.25;padding:.8125rem 1.375rem;min-height:2.875rem;border-radius:999px;border:2px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer;text-decoration:none;text-align:center;touch-action:manipulation;transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .1s ease}
button:hover,.button:hover{background:#3a332a;border-color:#3a332a}
button:active,.button:active{transform:scale(.97)}
button.secondary,a.button.secondary{background:transparent;color:var(--ink);border-color:#bfb299;font-weight:600}
button.secondary:hover,a.button.secondary:hover{background:#efe6d3;border-color:var(--ink);color:var(--ink)}
/* Destructive: red outline at rest, so it is never the loudest thing on the page */
button.danger{background:transparent;border-color:var(--danger);color:var(--danger);font-weight:600}
button.danger:hover{background:var(--danger);border-color:var(--danger);color:#fff}
/* Small repeated actions inside lists read as links, not a stack of pills */
button.link{background:none;border:0;border-radius:4px;padding:.25rem 0;min-height:0;color:inherit;font-weight:600;font-size:.9375rem;text-decoration:underline;text-underline-offset:.18em;text-decoration-thickness:1px}
button.link:hover{background:none;text-decoration-thickness:2px}
.chip{display:inline-block;font-size:.75rem;font-weight:700;color:var(--soft);border:1px solid #cbbfa6;border-radius:999px;padding:0 .5rem;margin-left:.375rem;vertical-align:.1em;white-space:nowrap}
button:disabled{opacity:.55;cursor:default;transform:none}
a.button{margin:0 0 .5rem}
.wide{display:block;width:100%}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.row form{margin:0}
.row button,.row .button{padding:.6875rem 1.125rem;margin:0}
.sep{text-align:center;margin:1rem 0}
form{margin:0 0 1rem}
/* A second form in the same panel (usually the destructive one) is set apart, never stacked under Save */
.card>form+form{margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--line)}

/* Fields */
label{display:block;font-weight:600;margin:0 0 .3125rem}
input[type=email],textarea,input.copy,select.copy,select{width:100%;font:inherit;padding:.75rem .875rem;min-height:2.875rem;border:1.5px solid var(--field);border-radius:10px;background:#fffdf8;color:var(--ink)}
select:not(.copy){width:auto}
input::placeholder,textarea::placeholder{color:#8f8573}
input:hover,textarea:hover,select:hover{border-color:var(--ink)}
input[type=checkbox],input[type=radio]{accent-color:var(--ink);width:1.25rem;height:1.25rem;flex-shrink:0;margin:.125rem 0 0}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;touch-action:manipulation}
details summary{cursor:pointer;font-weight:600;padding:.5rem 0;touch-action:manipulation}
details.more{margin:0 0 1rem}
details.more>summary{color:var(--ink)}
details.more[open]>summary{margin-bottom:.5rem}
details.more.card>summary{padding:0}
details.more.card[open]>summary{margin-bottom:1rem}
details[open]>:not(summary){animation:rise .2s ease both}

/* Lists */
.events{list-style:none;padding:0;margin:0 0 1rem}
.events li{padding:.875rem 0;margin:0;border-top:1px solid var(--line)}
.events li:first-child{border-top:0;padding-top:.25rem}
.when{display:block;font-size:.9375rem;color:var(--soft)}
.badge{display:inline-block;font-size:.8125rem;font-weight:700;color:var(--danger);background:#fbe9e4;border-radius:999px;padding:.05rem .625rem;vertical-align:.1em}

/* A calendar's own menu: a row of tabs that scrolls sideways on a phone instead of wrapping */
.tabs{display:flex;gap:1.125rem;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--line);margin:0 -1.25rem 1.125rem;padding:0 1.25rem;font-size:.9375rem;white-space:nowrap}
.tabs::-webkit-scrollbar{display:none}
.tabs a,.tabs strong{padding:.5rem 0 .625rem;border-bottom:3px solid transparent;text-decoration:none;color:var(--soft)}
.tabs a:hover{color:var(--ink);border-bottom-color:var(--line)}
.tabs strong,.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--accent);font-weight:700}

/* Home */
.hero{padding:.25rem 0 1.5rem}
.hero h1{font-size:2.625rem;line-height:1;margin:0 0 .875rem}
.hero h1 span{display:block;color:var(--accent-text)}
.hero .lead{font-size:1.0625rem;line-height:1.45;margin:0 0 1.125rem;color:#3a332a}
.hero .actions{display:flex;flex-wrap:wrap;gap:.25rem 1.125rem;align-items:center;margin:0 0 .625rem}
.hero .actions .button{margin:0}
.assure{font-size:.875rem;color:var(--soft);margin:0}
.demo{margin:1.75rem 0 0}
.slip{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.875rem 1rem;font-size:.9375rem;margin:0}
.slip small{display:block;color:var(--soft);font-size:.8125rem;margin:0 0 .375rem}
.becomes{font:400 1.25rem/1 var(--display);color:var(--accent-text);margin:.75rem 0 .5rem 1.5rem}
.how{list-style:none;padding:0;margin:0}
.how li{display:flex;gap:.875rem;padding:.75rem 0;margin:0;border-top:1px solid var(--line)}
.how li:first-child{border-top:0}
.how .n{flex-shrink:0;width:1.875rem;font:400 1.5rem/1.2 var(--display);color:var(--accent-text)}
.assure-line{text-align:center;font-size:.9375rem;color:var(--soft);margin:1.25rem 0 0}
.mail,.files{list-style:none;padding:0;margin:0}
.mail>li{padding:.875rem 0;margin:0;border-top:1px solid var(--line)}
.mail>li:first-child{border-top:0;padding-top:.25rem}
.mail p{margin:0}
.files{margin:.375rem 0 0}
.files li{margin:0;padding:.375rem 0 .375rem .875rem;border-left:2px solid var(--line);font-size:.9375rem}
.files img{float:right;margin-left:.5rem;border-radius:6px;object-fit:cover}
.files .acts{display:flex;flex-wrap:wrap;gap:0 1rem}
.files .acts form{margin:0}
@media (min-width:40rem){.hero h1{font-size:3.5rem}}
/* Wide screens: the home page uses the width (pitch left, the demo right, three steps across);
   the calendar page puts the list beside the subscribe panel. Other pages stay one calm column. */
@media (min-width:60rem){
  main{max-width:36rem}
  main:has(.hero),main:has(.two-up){max-width:66rem;padding-top:2rem}
  /* Organizer pages on a wide screen: the main work on the left, supporting things on the right. */
  main:has(.split){max-width:60rem}
  .split{display:grid;grid-template-columns:minmax(0,1fr) 21rem;gap:3.5rem;align-items:start}
  .split>*>.card:first-child:not(.panel){border-top:0;padding-top:.5rem}
  .hero{display:grid;grid-template-columns:1.25fr .75fr;gap:3.5rem;align-items:center;padding:2.5rem 0 3.5rem}
  .hero h1{font-size:4rem}
  .hero h1 span{white-space:nowrap}
  main:has(.hero) .card{padding-bottom:1.5rem}
  .assure-line{text-align:left}
  .hero .lead{font-size:1.1875rem;max-width:32rem}
  .demo{margin:0}
  .slip{font-size:1.0625rem;padding:1.125rem 1.25rem}
  .how{display:grid;grid-template-columns:repeat(3,1fr);gap:2.5rem}
  .how li{flex-direction:column;gap:.375rem;border-top:0;padding:0}
  .how .n{font-size:2rem}
  .two-up{display:grid;grid-template-columns:1fr 1fr;gap:3rem;align-items:start}
  .two-up>.card:not(.panel){border-top:0;padding-top:0}
  main:has(.two-up) .notes,main:has(.hero) .assure-line{max-width:32rem}
}
@media (prefers-reduced-motion:no-preference){.demo .slip{animation:rise .5s ease both}.demo .becomes{animation:rise .5s .25s ease both}.demo .cal{animation:rise .5s .45s ease both}}
@keyframes rise{from{opacity:0;translate:0 .5rem}to{opacity:1;translate:0 0}}

/* Event rows with a date tile (public calendar page and the home demo) */
.cal{list-style:none;padding:0;margin:0}
.cal li{display:flex;gap:.875rem;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.625rem .875rem;margin:0 0 .5rem}
.cal .day{width:2.875rem;flex-shrink:0;display:flex;flex-direction:column;text-align:center;border:1.5px solid var(--ink);border-radius:6px;overflow:hidden;background:#fff;font-variant-numeric:tabular-nums}
.cal .dow{font-size:.65625rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:#6b6152;padding:.125rem 0}
.cal .num{font:400 1.3125rem/1.3 var(--display)}
.cal .what{min-width:0;display:flex;flex-direction:column;gap:.0625rem;line-height:1.3}
.cal li.next .dow{background:var(--accent)}

/* Choices */
.pick{border:1.5px solid var(--line);border-radius:var(--radius);padding:1rem;margin:0 0 .75rem;background:#fffdf8}
.pick h2{font-size:1.1875rem;margin:0 0 .25rem;display:flex;align-items:center;gap:.5rem}
.pick form,.pick .button{margin:0}
.choice{border:0;padding:0;margin:0 0 .5rem;display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.choice legend{font-weight:600;margin-bottom:.5rem;padding:0}
.choice label{display:flex;gap:.5rem;align-items:flex-start;border:1.5px solid var(--line);border-radius:var(--radius);padding:1rem;cursor:pointer;background:#fffdf8;font-weight:400;touch-action:manipulation;transition:border-color .15s ease,background-color .15s ease}
.choice label:hover{border-color:var(--field)}
.choice label:has(input:checked){border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink);background:#fff}
@media (max-width:28rem){.choice{grid-template-columns:1fr}}
form:has(.choice input[value=public]:not(:checked)) .area{display:none}

/* Sharing */
.qr svg{width:12rem;height:12rem;display:block;margin:0 auto;background:#fff;border-radius:8px}
.flyer-controls{margin:0 0 1rem}
.flyer{text-align:center;border:1px solid var(--line);border-radius:var(--radius);padding:1.5rem;margin:0 0 1rem;background:#fff;color:#111}
.flyer h1{font-size:2.25rem;margin:0 0 .5rem}
.flyer .lead{font-size:1.125rem;margin:0 0 1rem}
.flyer .qr svg{width:14rem;height:14rem}
.flyer .steps{display:inline-block;text-align:left;margin:1rem auto;padding-left:1.25rem;font-size:1.0625rem}
.flyer .steps li{margin:0 0 .25rem}
.flyer .assure{font-weight:600;font-size:1rem;color:#111;margin:0 0 .5rem;overflow-wrap:normal}
.flyer .link{font-size:.8125rem;color:#5c5c5c;overflow-wrap:anywhere;margin:0}
.cut{border-top:2px dashed #767676;margin:1rem 0;position:relative;height:0}
.cut span{position:absolute;left:50%;top:-.7rem;transform:translateX(-50%);background:var(--paper);padding:0 .5rem;font-size:.75rem;color:var(--soft)}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}button:active,.button:active{transform:none}}
@media print{
  @page{size:letter;margin:.5in}
  body{background:#fff;color:#000}
  .no-print,.site,footer{display:none}
  main{max-width:none;padding:0}
  .card{padding:0;border:0;background:#fff}
  .cut span{background:#fff}
  .flyer{border:0;border-radius:0;padding:0;margin:0;height:10in;display:flex;flex-direction:column;align-items:center;justify-content:center;break-inside:avoid}
  .flyer h1{font-size:40pt}
  .flyer .lead{font-size:18pt}
  .flyer .qr svg{width:4.5in;height:4.5in}
  .flyer .steps{font-size:15pt}
  .flyer .assure{font-size:13pt}
  .flyer .link{font-size:9pt}
  .halves .flyer{height:4.75in}
  .halves .flyer h1{font-size:26pt;margin:0 0 .1in}
  .halves .flyer .lead{font-size:12pt;margin:0 0 .1in}
  .halves .flyer .qr svg{width:2.4in;height:2.4in}
  .halves .flyer .steps{font-size:11pt;margin:.1in auto}
  .halves .flyer .assure{font-size:10pt}
  .cut{margin:.1in 0}
}
`;

// Behaviour hooks are data attributes; no inline handlers anywhere (the CSP would block them).
//   data-copy="<input id>"  copy that input's value; data-count="<url>" also reports the tap
//   data-print              print the page
//   data-countdown="10"     remove this element after N seconds; [data-countdown-left] shows N
export const APP_JS = `"use strict";
// A picture that can't be shown (a phone format this browser can't read, or a damaged file) is
// hidden, so the page never shows a broken-image box.
(() => {
  const hide = (img) => { img.hidden = true; };
  for (const img of document.querySelectorAll("img")) {
    if (img.complete && img.naturalWidth === 0) hide(img);
    else img.addEventListener("error", () => hide(img), { once: true });
  }
})();
// D61: upload a file: ask for a one-time link, send the file straight to storage, then confirm.
(() => {
  const form = document.getElementById("upload-form");
  if (!form) return;
  const status = document.getElementById("upload-status");
  const say = (t) => { if (status) status.textContent = t; };
  const TYPES = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", webp: "image/webp", gif: "image/gif", txt: "text/plain", csv: "text/csv", ics: "text/calendar" };
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = form.querySelector("input[type=file]");
    const file = input && input.files && input.files[0];
    if (!file) { say("Choose a file first."); return; }
    if (file.size > 10 * 1024 * 1024) { say("That file is over 10 MB. Try a smaller copy, or just the pages with dates."); return; }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mime = TYPES[ext] || file.type;
    const csrf = form.querySelector("input[name=csrf]").value;
    const base = form.getAttribute("action").slice(0, -"/start".length); // action ends in /start
    const button = form.querySelector("button");
    const post = async (path, fields) => {
      const res = await fetch(base + path, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), credentials: "same-origin" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Something went wrong. Please try again.");
      return body;
    };
    button.disabled = true;
    try {
      say("Getting ready…");
      const start = await post("/start", { filename: file.name, mime, bytes: String(file.size) });
      say("Uploading…");
      const put = await fetch(start.url, { method: "PUT", body: file, headers: { "content-type": mime, "x-upsert": "false" } });
      if (!put.ok) throw new Error("The upload didn't finish. Please try again.");
      say("Checking the file…");
      const done = await post("/finish", { ticket: start.ticket });
      window.location.assign(done.redirect);
    } catch (e) {
      say(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      button.disabled = false;
    }
  });
})();
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
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1c1813"/><rect x="12" y="16" width="40" height="36" rx="5" fill="#fffaf0"/><rect x="12" y="16" width="40" height="10" rx="5" fill="#c2410c"/><rect x="20" y="10" width="5" height="12" rx="2" fill="#1c1813"/><rect x="39" y="10" width="5" height="12" rx="2" fill="#1c1813"/><path d="M22 39l7 7 13-14" fill="none" stroke="#1c1813" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const MANIFEST = JSON.stringify({
  name: "Calantern",
  short_name: "Calantern",
  description: "Turn school and team emails into a calendar families can subscribe to.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f6efe2",
  theme_color: "#f6efe2",
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
