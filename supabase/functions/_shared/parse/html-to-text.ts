// HTML email → plain text for the AI. Tables become rows ("cell | cell"), links become
// "text (url)", and images, tracking pixels, scripts, styles and hidden preheaders are dropped.
// Layout tables (cells holding blocks) are read as blocks, not as data rows.
import { parseHTML } from "npm:linkedom@0.18.14";

const SKIP = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "img", "picture", "video", "audio", "iframe", "object", "map", "button", "input", "select", "textarea"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "center", "form", "blockquote", "pre", "address", "figure", "figcaption", "dl", "dt", "dd", "ul", "ol", "table", "tbody", "thead", "tfoot", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "body", "html"]);

// deno-lint-ignore no-explicit-any
type El = any;

function hidden(el: El): boolean {
  if (el.hasAttribute?.("hidden")) return true;
  const style = String(el.getAttribute?.("style") ?? "").toLowerCase().replace(/\s+/g, "");
  return /display:none|visibility:hidden|mso-hide:all/.test(style);
}

function hasBlockChild(el: El): boolean {
  for (const child of el.children ?? []) {
    const tag = child.tagName?.toLowerCase();
    if (BLOCK.has(tag) || tag === "tr" || tag === "br" || hasBlockChild(child)) return true;
  }
  return false;
}

function linkText(inner: string, href: string): string {
  const text = inner.trim();
  if (!href) return inner;
  if (href.toLowerCase().startsWith("mailto:")) {
    const address = decodeURIComponent(href.slice(7).split("?")[0] ?? "");
    return !text || text.toLowerCase() === address.toLowerCase() ? address : `${text} (${address})`;
  }
  if (!/^https?:\/\//i.test(href)) return inner;
  if (!text) return ""; // an image link: the image is dropped, so is the link
  const bare = (s: string) => s.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
  return bare(text) === bare(href) ? href : `${text} (${href})`;
}

function walk(node: El, pre = false): string {
  if (node.nodeType === 3) {
    const t = String(node.textContent ?? "");
    return pre ? t : t.replace(/[ \t\r\n\f]+/g, " ");
  }
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag) || hidden(node)) return "";
  const kids = (inPre = pre) => Array.from(node.childNodes as El[]).map((c) => walk(c, inPre)).join("");
  switch (tag) {
    case "br":
      return "\n";
    case "a":
      return linkText(kids(), String(node.getAttribute("href") ?? "").trim());
    case "pre":
      return `\n${kids(true)}\n`;
    case "li":
      return `\n- ${kids().trim()}`;
    case "tr": {
      const cells = Array.from(node.children as El[]).filter((c) => /^(td|th)$/i.test(c.tagName) && !hidden(c));
      const layout = cells.some(hasBlockChild);
      const parts = cells.map((c) => walk(c).trim()).filter((s) => s.length > 0);
      if (parts.length === 0) return "";
      return layout ? `\n${parts.join("\n")}\n` : `\n${parts.join(" | ")}`;
    }
    case "td":
    case "th":
      return kids();
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return `\n\n${kids().trim()}\n\n`;
    case "hr":
      return "\n\n";
    default:
      return BLOCK.has(tag) ? `\n${kids()}\n` : kids();
  }
}

export function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[​-‍﻿͏]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  const doc = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
  // deno-lint-ignore no-explicit-any
  const { document } = parseHTML(doc) as any;
  return tidy(walk(document.body ?? document.documentElement));
}
