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

Deno.test("a TZID without a VTIMEZONE is read in that zone, whatever the machine's zone (CI runs in UTC)", () => {
  const [e] = parseIcs(ICS, "America/New_York", NOW);
  assertEquals(e?.starts_at, "2026-12-02T18:00:00.000Z"); // 10:00 Los Angeles, not New York, not the machine
  assertEquals(e?.timezone, "America/Los_Angeles");
  const floating = parseIcs(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:f@x", "DTSTART:20261202T100000", "SUMMARY:Floating", "END:VEVENT", "END:VCALENDAR"].join("\r\n"), "America/Chicago", NOW);
  assertEquals(floating[0]?.starts_at, "2026-12-02T16:00:00.000Z"); // floating → the feed's zone
});

const SERIES = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Club//EN",
  // Every Tuesday 4pm Pacific since October; 24 Nov removed; 1 Dec moved to Wednesday 5pm.
  "BEGIN:VEVENT", "UID:chess@club", "DTSTART;TZID=America/Los_Angeles:20261006T160000", "DTEND;TZID=America/Los_Angeles:20261006T170000",
  "SUMMARY:Chess club", "RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE;TZID=America/Los_Angeles:20261124T160000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:chess@club", "RECURRENCE-ID;TZID=America/Los_Angeles:20261201T160000", "DTSTART;TZID=America/Los_Angeles:20261202T170000",
  "DTEND;TZID=America/Los_Angeles:20261202T180000", "SUMMARY:Chess club (moved)", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

Deno.test("a date changed on its own does not overwrite the series; removed dates are skipped", () => {
  const events = parseIcs(SERIES, "America/Los_Angeles", NOW);
  assertEquals(events.length, 2);
  const [series, moved] = events;
  assertEquals(series?.uid, "chess@club");
  assertEquals(series?.rrule, "FREQ=WEEKLY;BYDAY=TU");
  assertEquals(series?.starts_at, "2026-10-06T23:00:00.000Z");
  // 24 Nov (EXDATE) and 1 Dec (changed on its own), both 4pm Pacific = midnight UTC next day.
  assertEquals(series?.exdates, ["2026-11-25T00:00:00.000Z", "2026-12-02T00:00:00.000Z"]);
  // Coming dates start after "now" (21 Nov) and leave both out: the next is 8 Dec.
  assertEquals(series?.occurrences.slice(0, 2), ["2026-12-09T00:00:00.000Z", "2026-12-16T00:00:00.000Z"]);
  assertEquals(series?.occurrences.length, 55); // Tuesdays from 8 Dec 2026 to 21 Dec 2027 (400 days ahead)
  assertEquals(moved?.uid, "chess@club#2026-12-02T00:00:00.000Z");
  assertEquals([moved?.title, moved?.rrule, moved?.starts_at], ["Chess club (moved)", null, "2026-12-03T01:00:00.000Z"]);
  assertEquals(moved?.occurrences, []);
});

Deno.test("a single event has no coming-dates list", () => {
  const events = parseIcs(ICS, "America/Los_Angeles", NOW);
  assertEquals(events[0]?.occurrences, []);
  // The book club's own start (a Thursday in UTC) is not a "first Wednesday", so the rule's dates begin in January.
  // Pages use the event's start as well as this list, so 3 Dec still shows.
  assertEquals(events[2]?.occurrences[0], "2027-01-06T02:00:00.000Z");
});
