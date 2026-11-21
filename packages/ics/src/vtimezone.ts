// Builds a VTIMEZONE (RFC 5545 §3.6.5) from the runtime's IANA data.
// Each offset change inside the year range becomes its own observance, with no RRULE.
// That is valid RFC 5545 and avoids guessing a zone's future rules.
import { formatLocal, formatOffset, offsetMinutes, type WallTime } from "./time.js";

const DAY = 86_400_000;
const MINUTE = 60_000;

interface Transition {
  at: number; // ms of the first instant with the new offset
  from: number;
  to: number;
}

function findTransitions(timeZone: string, startMs: number, endMs: number): Transition[] {
  const out: Transition[] = [];
  let prevMs = startMs;
  let prevOffset = offsetMinutes(startMs, timeZone);
  for (let t = startMs + DAY; t <= endMs; t += DAY) {
    const off = offsetMinutes(t, timeZone);
    if (off !== prevOffset) {
      // Binary search to the minute between prevMs (old offset) and t (new offset).
      let lo = prevMs;
      let hi = t;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.max(1, Math.floor((hi - lo) / 2 / MINUTE)) * MINUTE;
        if (offsetMinutes(mid, timeZone) === prevOffset) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: prevOffset, to: off });
      prevOffset = off;
    }
    prevMs = t;
  }
  return out;
}

function zoneAbbreviation(ms: number, timeZone: string): string | null {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")?.value;
  // Skip generic "GMT-8" style names; they add nothing.
  return name && !/^(GMT|UTC)[+-]/.test(name) ? name : null;
}

/**
 * VTIMEZONE lines for `timeZone`, covering whole years `fromYear`..`toYear`.
 * Starts with an observance at the range start, so every time in range is covered.
 */
export function vtimezone(timeZone: string, fromYear: number, toYear: number): string[] {
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  const transitions = findTransitions(timeZone, start, end);
  const offsets = [offsetMinutes(start, timeZone), ...transitions.map((t) => t.to)];
  const standardOffset = Math.min(...offsets);

  const observance = (at: number, from: number, to: number): string[] => {
    const kind = to > standardOffset ? "DAYLIGHT" : "STANDARD";
    // DTSTART is the local time of the change, expressed in the offset in effect before it:
    // the UTC instant shifted by the old offset, read as plain fields (no zone lookup).
    const shifted = new Date(at + from * MINUTE);
    const localBefore: WallTime = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
    const abbr = zoneAbbreviation(at, timeZone);
    return [
      `BEGIN:${kind}`,
      `DTSTART:${formatLocal(localBefore)}`,
      `TZOFFSETFROM:${formatOffset(from)}`,
      `TZOFFSETTO:${formatOffset(to)}`,
      ...(abbr ? [`TZNAME:${abbr}`] : []),
      `END:${kind}`,
    ];
  };

  const first = offsetMinutes(start, timeZone);
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${timeZone}`,
    ...observance(start, first, first),
    ...transitions.flatMap((t) => observance(t.at, t.from, t.to)),
    "END:VTIMEZONE",
  ];
}
