import { assertEquals } from "jsr:@std/assert@1";
import { parseIcs } from "./ics.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Library//EN",
  "BEGIN:VEVENT", "UID:story@lib", "DTSTART;TZID=America/Los_Angeles:20261202T100000", "DTEND;TZID=America/Los_Angeles:20261202T110000", "SUMMARY:Story time", "LOCATION:Room A", "END:VEVENT",
  "BEGIN:VEVENT", "UID:closed@lib", "DTSTART;VALUE=DATE:20261126", "DTEND;VALUE=DATE:20261128", "SUMMARY:Closed for Thanksgiving", "END:VEVENT",
  "BEGIN:VEVENT", "UID:club@lib", "DTSTART:20261203T020000Z", "SUMMARY:Book club", "RRULE:FREQ=MONTHLY;BYDAY=1WE", "STATUS:CONFIRMED", "END:VEVENT",
  "BEGIN:VEVENT", "UID:old@lib", "DTSTART:20250101T180000Z", "SUMMARY:Last year", "END:VEVENT",
  "BEGIN:VEVENT", "UID:off@lib", "DTSTART:20261205T180000Z", "SUMMARY:Cancelled talk", "STATUS:CANCELLED", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

Deno.test("imports current events with zones, all-day ranges, recurrence and cancellations", () => {
  const events = parseIcs(ICS, "America/Los_Angeles", NOW);
  assertEquals(events.map((e) => e.uid), ["story@lib", "closed@lib", "club@lib", "off@lib"]);
  assertEquals(events[0]?.starts_at, "2026-12-02T18:00:00.000Z");
  assertEquals(events[0]?.location, "Room A");
  assertEquals([events[1]?.all_day, events[1]?.ends_at?.slice(0, 10)], [true, "2026-11-27"]);
  assertEquals(events[2]?.rrule, "FREQ=MONTHLY;BYDAY=1WE");
  assertEquals(events[3]?.status, "cancelled");
});
