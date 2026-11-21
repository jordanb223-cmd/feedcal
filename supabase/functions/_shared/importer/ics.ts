// Reads a public .ics calendar into events for an imported feed (Phase 13, D34). Pure.
import ICAL from "npm:ical.js@2.2.1";
import { zonedToUtc } from "../extract/checks.ts";

export interface ImportedEvent {
  uid: string; title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean; timezone: string; rrule: string | null; status: "confirmed" | "cancelled";
}

const MAX_EVENTS = 2000;

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
  for (const comp of root.getAllSubcomponents("vevent")) {
    if (out.length >= MAX_EVENTS) break;
    const e = new ICAL.Event(comp);
    if (!e.uid || !e.startDate) continue;
    const start = e.startDate;
    const rrule = comp.getFirstPropertyValue("rrule");
    const tzParam = comp.getFirstProperty("dtstart")?.getParameter("tzid");
    const declaredTz = typeof tzParam === "string" ? tzParam : null;
    const startMs = start.isDate ? Date.parse(zonedToUtc(`${start.year}-${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}T12:00`, declaredTz && isZone(declaredTz) ? declaredTz : defaultTz)) : instant(start, declaredTz, defaultTz);
    // Keep what's current: recurring series, and single events from 30 days ago onwards.
    if (!rrule && startMs < now - 30 * 86_400_000) continue;
    const zone = start.zone?.tzid;
    const tzid = declaredTz && isZone(declaredTz) ? declaredTz : zone && zone !== "floating" && zone !== "UTC" && zone !== "Z" && isZone(zone) ? zone : null;
    const status = String(comp.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed";
    out.push({
      uid: String(e.uid).slice(0, 500),
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
    });
  }
  return out;
}
