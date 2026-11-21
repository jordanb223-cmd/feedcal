// Forwards and replies, in plain text after HTML conversion.
// unwrapForwards: finds Gmail, Apple Mail and Outlook forward headers, keeps the innermost
//   original (its sender, subject and date), and returns the forwarders' notes separately.
// stripQuotes: cuts quoted replies and signatures. What's cut is returned, so it can be kept
//   for evidence; it is never sent to the AI.

export interface ForwardHeaders { from: string | null; date: string | null; subject: string | null }
export interface Unwrapped { body: string; notes: string[]; depth: number; headers: ForwardHeaders | null }

const GMAIL = /^-{4,}\s*Forwarded message\s*-{4,}\s*$/i;
const APPLE = /^Begin forwarded message:\s*$/i;
const OUTLOOK_RULE = /^_{10,}\s*$/;
const ORIGINAL = /^-{3,}\s*Original Message\s*-{3,}\s*$/i;
const HEADER_LINE = /^(From|Date|Sent|Subject|To|Cc|Reply-To)\s*:\s*(.*)$/i;
const FWD_SUBJECT = /^\s*(fw|fwd)\s*:/i;

interface Marker { index: number; kind: "gmail" | "apple" | "outlook" | "original" }

/** The next line with text after index i (HTML conversion often leaves blank lines between blocks). */
function nextText(lines: string[], i: number): string {
  for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim()) return lines[j]!.trim();
  return "";
}

function findMarker(lines: string[], subject: string | null): Marker | null {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (GMAIL.test(l)) return { index: i, kind: "gmail" };
    if (APPLE.test(l)) return { index: i, kind: "apple" };
    // Outlook uses the same block for replies and forwards; only a FW: subject makes it a forward.
    const nextIsFrom = /^From\s*:/i.test(nextText(lines, i));
    if (FWD_SUBJECT.test(subject ?? "") && ((OUTLOOK_RULE.test(l) && nextIsFrom) || ORIGINAL.test(l))) return { index: i, kind: l.startsWith("_") ? "outlook" : "original" };
    // Outlook mobile / some clients: a bare header block (From, Sent|Date, Subject) after a FW: subject.
    if (FWD_SUBJECT.test(subject ?? "") && /^From\s*:/i.test(l) && i > 0 && headerBlock(lines, i).count >= 3) return { index: i - 1, kind: "outlook" };
  }
  return null;
}

function headerBlock(lines: string[], start: number): { headers: ForwardHeaders; count: number; end: number } {
  const headers: ForwardHeaders = { from: null, date: null, subject: null };
  let i = start;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  let count = 0;
  for (; i < lines.length; i++) {
    const m = HEADER_LINE.exec(lines[i]!.trim());
    if (!m) break;
    count++;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "from") headers.from = value;
    else if (key === "date" || key === "sent") headers.date = value;
    else if (key === "subject") headers.subject = value;
  }
  return { headers, count, end: i };
}

export function unwrapForwards(text: string, subject: string | null, maxDepth = 5): Unwrapped {
  let body = text;
  let currentSubject = subject;
  const notes: string[] = [];
  let headers: ForwardHeaders | null = null;
  let depth = 0;
  while (depth < maxDepth) {
    const lines = body.split("\n");
    const marker = findMarker(lines, currentSubject);
    if (!marker) break;
    const block = headerBlock(lines, marker.index + 1);
    if (block.count < 2) break;
    // A divider right before the header block belongs to the block, not to the note.
    const note = lines.slice(0, marker.index).join("\n").replace(/(\n|^)\s*(_{10,}|-{3,}\s*Original Message\s*-{3,})\s*$/i, "").trim();
    if (note) notes.push(note);
    headers = block.headers;
    currentSubject = block.headers.subject ?? currentSubject;
    body = lines.slice(block.end).join("\n").trim();
    depth++;
  }
  return { body, notes, depth, headers };
}

const ON_WROTE = /^On\s.{4,300}\bwrote:\s*$/i;
const SIG_DASH = /^--\s?$/;
const MOBILE_SIG = /^(Sent from my (iPhone|iPad|Android|Samsung|Galaxy|Pixel|phone|mobile)\b.*|Get Outlook for (iOS|Android)\b.*|Sent from (Mail|Outlook|Yahoo Mail) for .*)$/i;

export function stripQuotes(text: string): { clean: string; stripped: string } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const cut: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    const joined = i + 1 < lines.length ? `${l} ${lines[i + 1]!.trim()}` : l;
    const replyHeader =
      ON_WROTE.test(l) ||
      (/^On\s/i.test(l) && ON_WROTE.test(joined)) ||
      ORIGINAL.test(l) ||
      (OUTLOOK_RULE.test(l) && /^From\s*:/i.test(nextText(lines, i))) ||
      (/^From\s*:/i.test(l) && /^(Sent|Date)\s*:/i.test(lines[i + 1]?.trim() ?? "") && i > 0);
    if (replyHeader) {
      cut.push(...lines.slice(i));
      break;
    }
    if (SIG_DASH.test(lines[i]!) && lines.length - i <= 12) {
      cut.push(...lines.slice(i));
      break;
    }
    if (l.startsWith(">") || MOBILE_SIG.test(l)) {
      cut.push(lines[i]!);
      continue;
    }
    kept.push(lines[i]!);
  }
  return { clean: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), stripped: cut.join("\n").trim() };
}

// ---------------------------------------------------------------- dates in forward headers
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZONES: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, PST: -480, PDT: -420, MST: -420, MDT: -360, CST: -360, CDT: -300, EST: -300, EDT: -240,
  AKST: -540, AKDT: -480, HST: -600, BST: 60, CET: 60, CEST: 120, IST: 330, AEST: 600, AEDT: 660,
};

/** The UTC offset in minutes from an RFC 2822 Date header ("... -0800"), or null. */
export function headerOffset(dateHeader: string | null | undefined): number | null {
  const m = /([+-])(\d{2})(\d{2})\s*(\([^)]*\))?\s*$/.exec(dateHeader ?? "");
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

function zoneOffset(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.toUpperCase();
  if (t in ZONES) return ZONES[t]!;
  const m = /^(?:GMT|UTC)?([+-])(\d{1,2}):?(\d{2})?$/.exec(t);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

function toIso(y: number, mo: number, d: number, h: number, mi: number, s: number, offset: number): string | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo, d, h, mi, s) - offset * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Dates as mail clients write them in forward headers. When the line has no zone, the
 * fallback offset (the outer message's own Date header) is used.
 *   Gmail:   "Mon, Nov 17, 2026 at 9:14 AM"
 *   Apple:   "November 17, 2026 at 9:14:02 AM PST"
 *   Outlook: "Monday, November 17, 2026 9:14 AM" / "11/17/2026 9:14 AM"
 *   RFC 2822 "Mon, 17 Nov 2026 09:14:00 -0800"
 */
export function parseLooseDate(value: string | null, fallbackOffset: number): string | null {
  if (!value) return null;
  const v = value.replace(/^[A-Za-z]+,\s*/, "").replace(/\s+/g, " ").trim();
  const hm = (h: string | undefined, ap: string | undefined) => {
    let hour = Number(h ?? 0);
    if (ap) {
      const pm = ap.toUpperCase() === "PM";
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
    }
    return hour;
  };
  let m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?([+-]\d{4}|[A-Z]{1,4})?/.exec(v);
  if (m) {
    const off = zoneOffset(m[7]) ?? fallbackOffset;
    return toIso(Number(m[3]), MONTHS.indexOf(m[2]!.toLowerCase()), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), off);
  }
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})(?:,? (?:at )?(\d{1,2}):(\d{2})(?::(\d{2}))? ?([AaPp][Mm])?)? ?([A-Za-z]{1,5}|(?:GMT|UTC)?[+-]\d{1,2}:?\d{0,2})?/.exec(v);
  if (m && MONTHS.includes(m[1]!.toLowerCase())) {
    const off = zoneOffset(m[8]) ?? fallbackOffset;
    return toIso(Number(m[3]), MONTHS.indexOf(m[1]!.toLowerCase()), Number(m[2]), hm(m[4], m[7]), Number(m[5] ?? 0), Number(m[6] ?? 0), off);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AaPp][Mm])?)?/.exec(v);
  if (m) {
    return toIso(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hm(m[4], m[7]), Number(m[5] ?? 0), Number(m[6] ?? 0), fallbackOffset);
  }
  return null;
}

/** "Name <a@b>", "a@b", "Name a@b" → {address, name}. */
export function parseSender(value: string | null): { address: string; name: string | null } | null {
  if (!value) return null;
  const angled = /^(.*?)<([^<>\s]+@[^<>\s]+)>/.exec(value);
  if (angled) {
    const name = angled[1]!.replace(/["']/g, "").trim();
    return { address: angled[2]!.toLowerCase(), name: name || null };
  }
  const bare = /([^\s<>"(),;:]+@[^\s<>"(),;:]+\.[a-z]{2,})/i.exec(value);
  if (!bare) return null;
  const name = value.replace(bare[0], "").replace(/[\[\]()"<>]/g, "").trim();
  return { address: bare[1]!.toLowerCase(), name: name || null };
}
