// Reads a public .ics calendar into events for an imported feed (Phase 13, D34). Pure.
import ICAL from "npm:ical.js@2.2.1";

export interface ImportedEvent {
  uid: string; title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean; timezone: string; rrule: string | null; status: "confirmed" | "cancelled";
}

const MAX_EVENTS = 2000;

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
    const startMs = start.toJSDate().getTime();
    // Keep what's current: recurring series, and single events from 30 days ago onwards.
    if (!rrule && startMs < now - 30 * 86_400_000) continue;
    const zone = start.zone?.tzid;
    const tzid = zone && zone !== "floating" && zone !== "UTC" && zone !== "Z" ? zone : null;
    const status = String(comp.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed";
    out.push({
      uid: String(e.uid).slice(0, 500),
      title: (e.summary || "Event").slice(0, 300),
      description: e.description ? String(e.description).slice(0, 8000) : null,
      location: e.location ? String(e.location).slice(0, 500) : null,
      starts_at: start.toJSDate().toISOString(),
      // All-day DTEND is exclusive; Feedcal stores the last day (D22).
      ends_at: e.endDate ? new Date(e.endDate.toJSDate().getTime() - (start.isDate ? 86_400_000 : 0)).toISOString() : null,
      all_day: start.isDate,
      timezone: tzid && tzid.includes("/") ? tzid : defaultTz,
      rrule: rrule ? String(rrule.toString()).slice(0, 500) : null,
      status,
    });
  }
  return out;
}
