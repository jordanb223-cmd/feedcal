// Reads a public .ics calendar into events for an imported feed (Phase 13, D34). Pure.
import ICAL from "npm:ical.js@2.2.1";
import { zonedToUtc } from "../extract/checks.ts";

export interface ImportedEvent {
  uid: string; title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean; timezone: string; rrule: string | null; status: "confirmed" | "cancelled";
  /** Starts of single dates taken out of a repeating event (EXDATE, or a date that was changed on its own). */
  exdates: string[];
  /** For a repeating event: its coming starts, soonest first. Lets pages show the next date without reading the rule. */
  occurrences: string[];
}

const MAX_EVENTS = 2000;
const MAX_EXDATES = 500;
const MAX_OCCURRENCES = 120;
const LOOK_AHEAD_MS = 400 * 86_400_000;
const MAX_STEPS = 3000; // a rule that started years ago is walked forward at most this far

// deno-lint-ignore no-explicit-any
type IcalTime = any;

/**
 * The instant a DTSTART/DTEND means. ical.js converts with the MACHINE's zone when a TZID has no
 * VTIMEZONE in the file (or the time is floating), so those are converted here from wall-clock
 * time in the named zone, or the feed's zone. UTC and defined zones use ical.js directly.
 */
function instant(t: IcalTime, tzid: string | null, defaultTz: string): number {
  const zone = t.zone?.tzid;
  if (zone === "UTC" || (zone && zone !== "floating" && ICAL.TimezoneService.has(zone))) return t.toJSDate().getTime();
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = tzid && isZone(tzid) ? tzid : defaultTz;
  return Date.parse(zonedToUtc(`${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour ?? 0)}:${pad(t.minute ?? 0)}`, tz)) + (t.second ?? 0) * 1000;
}
function isZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function parseIcs(text: string, defaultTz: string, now = Date.now()): ImportedEvent[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const vtz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
  const out: ImportedEvent[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  // The instant a start means, by the same rules for a series, its changed dates and its removed dates.
  const startOf = (t: IcalTime, declaredTz: string | null) => t.isDate
    ? Date.parse(zonedToUtc(`${t.year}-${pad(t.month)}-${pad(t.day)}T12:00`, declaredTz && isZone(declaredTz) ? declaredTz : defaultTz))
    : instant(t, declaredTz, defaultTz);
  const vevents = root.getAllSubcomponents("vevent");
  // A date changed on its own arrives as a second VEVENT with the series' UID and a RECURRENCE-ID.
  // Stored under the same UID it would overwrite the series, so it gets its own, and the series skips that date.
  const moved = new Map<string, number[]>();
  for (const comp of vevents) {
    const rid = comp.getFirstPropertyValue("recurrence-id");
    const uid = comp.getFirstPropertyValue("uid");
    if (!rid || !uid) continue;
    const tz = comp.getFirstProperty("recurrence-id")?.getParameter("tzid");
    const at = startOf(rid, typeof tz === "string" ? tz : null);
    moved.set(String(uid), [...(moved.get(String(uid)) ?? []), at]);
  }
  for (const comp of vevents) {
    if (out.length >= MAX_EVENTS) break;
    const e = new ICAL.Event(comp);
    if (!e.uid || !e.startDate) continue;
    const start = e.startDate;
    const recurrenceId = comp.getFirstPropertyValue("recurrence-id");
    const rrule = recurrenceId ? null : comp.getFirstPropertyValue("rrule");
    const tzParam = comp.getFirstProperty("dtstart")?.getParameter("tzid");
    const declaredTz = typeof tzParam === "string" ? tzParam : null;
    const startMs = start.isDate ? Date.parse(zonedToUtc(`${start.year}-${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}T12:00`, declaredTz && isZone(declaredTz) ? declaredTz : defaultTz)) : instant(start, declaredTz, defaultTz);
    // Keep what's current: recurring series, and single events from 30 days ago onwards.
    if (!rrule && startMs < now - 30 * 86_400_000) continue;
    const zone = start.zone?.tzid;
    const tzid = declaredTz && isZone(declaredTz) ? declaredTz : zone && zone !== "floating" && zone !== "UTC" && zone !== "Z" && isZone(zone) ? zone : null;
    const status = String(comp.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed";
    let uid = String(e.uid);
    const exMs: number[] = [];
    const occurrences: string[] = [];
    if (recurrenceId) {
      const ridTz = comp.getFirstProperty("recurrence-id")?.getParameter("tzid");
      uid = `${uid.slice(0, 460)}#${new Date(startOf(recurrenceId, typeof ridTz === "string" ? ridTz : null)).toISOString()}`;
    } else if (rrule) {
      for (const prop of comp.getAllProperties("exdate")) {
        const exTz = prop.getParameter("tzid");
        for (const v of prop.getValues()) exMs.push(startOf(v, typeof exTz === "string" ? exTz : declaredTz));
      }
      exMs.push(...(moved.get(uid) ?? []));
      const skip = new Set(exMs);
      try {
        const it = e.iterator();
        for (let steps = 0; steps < MAX_STEPS && occurrences.length < MAX_OCCURRENCES; steps++) {
          const next = it.next();
          if (!next) break;
          const at = startOf(next, declaredTz);
          if (at > now + LOOK_AHEAD_MS) break;
          if (at >= now - 86_400_000 && !skip.has(at)) occurrences.push(new Date(at).toISOString());
        }
      } catch { /* a rule ical.js can't walk: the event keeps its first date only */ }
    }
    out.push({
      uid: uid.slice(0, 500),
      title: (e.summary || "Event").slice(0, 300),
      description: e.description ? String(e.description).slice(0, 8000) : null,
      location: e.location ? String(e.location).slice(0, 500) : null,
      starts_at: new Date(startMs).toISOString(),
      // All-day DTEND is exclusive; Feedcal stores an instant on the last day (D22).
      ends_at: e.endDate ? new Date(start.isDate ? Date.parse(zonedToUtc(`${e.endDate.year}-${String(e.endDate.month).padStart(2, "0")}-${String(e.endDate.day).padStart(2, "0")}T12:00`, tzid ?? defaultTz)) - 86_400_000 : instant(e.endDate, declaredTz, defaultTz)).toISOString() : null,
      all_day: start.isDate,
      timezone: tzid && tzid.includes("/") ? tzid : defaultTz,
      rrule: rrule ? String(rrule.toString()).slice(0, 500) : null,
      status,
      exdates: [...new Set(exMs)].sort((a, b) => a - b).slice(0, MAX_EXDATES).map((t) => new Date(t).toISOString()),
      occurrences,
    });
  }
  return out;
}
