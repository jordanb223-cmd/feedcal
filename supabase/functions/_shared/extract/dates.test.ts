import { assertEquals } from "jsr:@std/assert@1";
import { dateGate, writtenDates, writtenTimes } from "./dates.ts";

const LA = "America/Los_Angeles";
// Wednesday 11 Nov 2026, 10:00 in Los Angeles.
const WED = "2026-11-11T18:00:00Z";
// Friday 13 Nov 2026, 13:16 in Los Angeles: the Room F email.
const FRI = "2026-11-13T21:16:00Z";
const gate = (start: string, quote: string, referenceDate = WED, allDay = !start.includes("T")) =>
  dateGate({ start, allDay, timezone: LA, quote, referenceDate });

Deno.test("written dates are found in the usual forms", () => {
  assertEquals(writtenDates("Friday, Nov 20"), [{ m: 11, d: 20, y: undefined }]);
  assertEquals(writtenDates("November 20th, 2026"), [{ m: 11, d: 20, y: 2026 }]);
  assertEquals(writtenDates("on 20 November"), [{ m: 11, d: 20, y: undefined }]);
  assertEquals(writtenDates("11/20/26"), [{ m: 11, d: 20, y: 2026 }]);
  assertEquals(writtenDates("2026-11-20"), [{ y: 2026, m: 11, d: 20 }]);
  assertEquals(writtenDates("May the force"), []);
});

Deno.test("written times", () => {
  assertEquals(writtenTimes("3pm to 4:30 p.m."), [900, 990]);
  assertEquals(writtenTimes("at 15:30"), [930]);
  assertEquals(writtenTimes("pickup at noon"), [720]);
  assertEquals(writtenTimes("12am"), [0]);
});

Deno.test("a written date that matches confirms it", () => {
  assertEquals(gate("2026-11-20", "Friday, Nov 20 is Dinos-giving"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-20", "Thanksgiving potluck on 11/20"), { confirmed: true, review: [] });
  assertEquals(gate("2026-12-02", "Dec 2-4: book fair"), { confirmed: true, review: [] });
});

Deno.test("a written date that disagrees goes to review", () => {
  assertEquals(gate("2026-11-21", "Friday, Nov 20 is Dinos-giving").review, ["date_mismatch"]);
  assertEquals(gate("2026-11-20", "Thursday, Nov 20").review, ["weekday_mismatch"]);
  assertEquals(gate("2027-11-20", "Nov 20, 2026").review, ["date_mismatch"]);
});

Deno.test("relative days from the sent date", () => {
  assertEquals(gate("2026-11-11", "Picture day is today!"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-12", "Tomorrow: field trip"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-13", "This Friday is pajama day"), { confirmed: true, review: [] }); // Wed → Fri
  assertEquals(gate("2026-11-13", "Pajama day on Friday"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-20", "This Friday is pajama day").review, ["date_mismatch"]);
});

Deno.test("Room F: 'This Friday', sent on a Friday, is ambiguous", () => {
  assertEquals(gate("2026-11-20", "This Friday is “Dinos”giving!", FRI), { confirmed: false, review: ["ambiguous_date"] });
});

Deno.test("'next Friday' mid-week is ambiguous; on a Friday it means in 7 days", () => {
  assertEquals(gate("2026-11-20", "Next Friday: no school").review, ["ambiguous_date"]);
  assertEquals(gate("2026-11-20", "Next Friday: no school", FRI), { confirmed: true, review: [] });
});

Deno.test("'last Friday' isn't counted as a date", () => {
  assertEquals(gate("2026-11-13", "Thanks for coming last Friday"), { confirmed: false, review: [] });
});

Deno.test("an event before the email was sent goes to review", () => {
  assertEquals(gate("2026-11-06", "Nov 6 assembly").review, ["before_email"]);
});

Deno.test("timed events: the written time must match", () => {
  assertEquals(gate("2026-11-20T15:00", "Nov 20, 3pm-5pm"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-20T16:00", "Nov 20, 3pm-5pm").review, ["time_mismatch"]);
  assertEquals(gate("2026-11-20T18:00", "Nov 20: doors 5:30, show at 6pm"), { confirmed: true, review: [] });
});

Deno.test("no date words at all: not confirmed, not flagged (the feed's normal bar applies)", () => {
  assertEquals(gate("2026-11-20", "Dinos-giving celebration and potluck"), { confirmed: false, review: [] });
});

Deno.test("the sent date is taken in the event's zone, not UTC", () => {
  // 21:30 Thursday in LA is already Friday in UTC: "tomorrow" is still Friday.
  assertEquals(gate("2026-11-13", "Tomorrow is pajama day", "2026-11-13T05:30:00Z"), { confirmed: true, review: [] });
});
