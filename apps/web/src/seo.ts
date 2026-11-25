// D60: what search engines and link previews (iMessage, social apps) read for public pages.
import type { Context } from "hono";
import { html } from "hono/html";
import { originOf } from "./security.js";

export function seoHead(c: Context, title: string, description: string) {
  const url = `${originOf(c)}${new URL(c.req.url).pathname}`;
  return html`<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bumpdraft">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">`;
}
