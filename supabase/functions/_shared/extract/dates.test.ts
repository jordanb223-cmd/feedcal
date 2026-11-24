import { assertEquals } from "jsr:@std/assert@1";
import { dateGate, endDayStated, statedDays, timesIn, timeStated, writtenDates, writtenTimes } from "./dates.ts";

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
  assertEquals(gate("2026-11-20", "This Friday is “Dinos”giving!", FRI), { confirmed: false, review: ["ambiguous_date"], options: ["2026-11-13", "2026-11-20"] });
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

// D82: an end day counts only when the words state it.
Deno.test("ranges and lists state their later days", () => {
  assertEquals(statedDays("NOVEMBER 26 & 27 – NO SCHOOL"), [{ m: 11, d: 26 }, { m: 11, d: 27 }]);
  assertEquals(statedDays("Nov 26-28: Thanksgiving break").map((v) => v.d), [26, 28]);
  assertEquals(statedDays("Nov 20 6-8:30 PM").map((v) => v.d), [20], "6-8:30 is a time range");
  assertEquals(statedDays("Book fair Dec 1 through 5").map((v) => v.d), [1, 5]);
  assertEquals(statedDays("Camp 6/15-19").map((v) => `${v.m}/${v.d}`), ["6/15", "6/19"]);
  assertEquals(statedDays("Conferences Nov 3, 4 and 5").map((v) => v.d), [3], "a comma list is not read as a range");
  assertEquals(statedDays("DECEMBER 18 – DINO CHRISTMAS MUSICAL & STUFFY EXCHANGE"), [{ m: 12, d: 18 }]);
  assertEquals(statedDays("Nov 20 at 6-8 PM").map((v) => v.d), [20], "a time range is not a day range");
  assertEquals(statedDays("Nov 20, 2026").map((v) => v.d), [20]);
});

Deno.test("an end day is stated by a date, a range, or a weekday range; never by silence", () => {
  assertEquals(endDayStated("NOVEMBER 26 & 27 – NO SCHOOL", "2026-11-27"), true);
  assertEquals(endDayStated("Break runs Nov 26 – Dec 2", "2026-12-02"), true);
  assertEquals(endDayStated("DECEMBER 18 – DINO CHRISTMAS MUSICAL & STUFFY EXCHANGE", "2026-12-19"), false);
  assertEquals(endDayStated("Since there is no school on Friday, we will share on Wednesday.", "2026-11-26"), false, "Thursday is not named");
  assertEquals(endDayStated("No school Monday through Wednesday", "2026-11-25"), true, "25 Nov 2026 is a Wednesday");
  assertEquals(endDayStated("We will share on Wednesday", "2026-11-25"), false, "one weekday is not a range");
});

// D83: AM/PM in a range covers both ends.
Deno.test("a range's AM/PM applies to its start too", () => {
  assertEquals(writtenTimes("Friday, November 20, 6:30-8 PM"), [1110, 1200]);
  assertEquals(writtenTimes("from 6:30 to 8:00 p.m."), [1110, 1200]);
  assertEquals(writtenTimes("11-1 PM"), [660, 780], "the start can't be after the end, so 11 is AM");
  assertEquals(writtenTimes("9 to 11:30 am"), [540, 690]);
  assertEquals(gate("2026-11-20T18:30", "Nov 20, 6:30-8 PM"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-20T06:30", "Nov 20, 6:30-8 PM").review, ["time_mismatch"]);
});

// D84: with no AM/PM, 7 to 11 is morning and 12 to 6 is afternoon. Likely, never proof.
Deno.test("a time with no AM/PM is read by the usual hours, and proves nothing", () => {
  const f = (q: string) => timesIn(q).map((x) => [x.minutes, x.definite]);
  assertEquals(f("pickup at 3:15"), [[915, false]]);
  assertEquals(f("starts at 8:00"), [[480, false]]);
  assertEquals(f("lunch at 12:30"), [[750, true]], "12:30 with no AM/PM is the afternoon");
  assertEquals(f("1:00 dismissal"), [[780, false]]);
  assertEquals(f("6:30-8"), [[1110, false], [1200, false]], "the end is the first such time after the start");
  assertEquals(f("11:30-1"), [[690, false], [780, false]]);
  assertEquals(f("8:00 to 3:00"), [[480, false], [900, false]]);
  assertEquals(f("Nov 20-21"), [], "a day range is not a time");
  assertEquals(f("11/20-21"), []);
  // The usual reading: unproven, so the feed's bar decides. No review reason.
  assertEquals(gate("2026-11-20T15:15", "Nov 20 at 3:15"), { confirmed: false, review: [] });
  assertEquals(gate("2026-11-20T08:00", "Nov 20 at 8:00"), { confirmed: false, review: [] });
  // The unusual reading waits for the owner.
  assertEquals(gate("2026-11-20T03:15", "Nov 20 at 3:15").review, ["time_unlikely"]);
  assertEquals(gate("2026-11-20T20:00", "Nov 20 at 8:00").review, ["time_unlikely"]);
  // A different time altogether is still a mismatch.
  assertEquals(gate("2026-11-20T16:00", "Nov 20 at 3:15").review, ["time_mismatch"]);
});

Deno.test("morning, afternoon, evening or night settle a time with no AM/PM", () => {
  assertEquals(gate("2026-11-20T19:00", "Evening concert Nov 20 at 7:00"), { confirmed: true, review: [] });
  assertEquals(gate("2026-11-20T07:00", "Evening concert Nov 20 at 7:00").review, ["time_mismatch"]);
  assertEquals(gate("2026-11-20T08:15", "Morning assembly Nov 20 at 8:15"), { confirmed: true, review: [] });
  assertEquals(timesIn("tonight 6:30-8").map((x) => [x.minutes, x.definite]), [[1110, true], [1200, true]]);
  // Both words: neither settles it, so the usual hours apply and a 7:00 read as evening waits.
  assertEquals(timeStated("morning drop-off 8:00, evening show 7:00", 1140), "unlikely");
  assertEquals(timeStated("morning drop-off 8:00, evening show 7:00", 480), "maybe");
});

Deno.test("timeStated: yes, maybe, unlikely, no, silent", () => {
  assertEquals(timeStated("doors 6 PM, show 7 PM", 1140), "yes");
  assertEquals(timeStated("doors 6 PM, show 7 PM", 1080), "yes");
  assertEquals(timeStated("doors 6 PM, show 7 PM", 1200), "no");
  assertEquals(timeStated("at 3:15", 915), "maybe");
  assertEquals(timeStated("at 3:15", 195), "unlikely");
  assertEquals(timeStated("Holiday party in Room 12", 600), "silent");
});
