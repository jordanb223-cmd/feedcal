// Time-zone math using the runtime's IANA data (Intl). No external tz database.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock time in `timeZone` at instant `ms`. */
export function wallTime(ms: number, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** UTC offset of `timeZone` at instant `ms`, in minutes (e.g. -480 for PST). */
export function offsetMinutes(ms: number, timeZone: string): number {
  const w = wallTime(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 20261124T090000 (local, no zone designator). */
export function formatLocal(w: WallTime): string {
  return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
}

/** 20261124 (DATE value). */
export function formatDate(w: Pick<WallTime, "year" | "month" | "day">): string {
  return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}`;
}

/** 20261124T170000Z (UTC DATE-TIME). */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** -0800 / +0530 */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** The calendar date one day after `w` (handles month and year ends). */
export function nextDay(w: Pick<WallTime, "year" | "month" | "day">): Pick<WallTime, "year" | "month" | "day"> {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
