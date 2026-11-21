// RFC 5545 text escaping and line folding.

/** Escapes a TEXT value (RFC 5545 §3.3.11): backslash, semicolon, comma, newline. */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1). Continuation lines start with one space,
 * which counts toward their 75. Never splits a UTF-8 character or a surrogate pair.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    // `for...of` iterates by code point, so surrogate pairs stay together.
    const size = encoder.encode(ch).length;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = 74; // the leading space takes one octet
    }
    current += ch;
    currentBytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** Joins content lines with CRLF, folding each, ending with a final CRLF. */
export function serialize(lines: readonly string[]): string {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
