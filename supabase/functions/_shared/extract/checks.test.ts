import { assertEquals } from "jsr:@std/assert@1";
import { personalDetails } from "./checks.ts";

Deno.test("personal details in event text are found; venues and times are not", () => {
  assertEquals(personalDetails({ title: "Pickup from Sam's house", description: "Call (916) 555-0142 or text 916.555.0142" }), ["phone"]);
  assertEquals(personalDetails({ title: "Carpool", description: "Meet at 1428 Maple Drive" }), ["street_address"]);
  assertEquals(personalDetails({ title: "RSVP", description: "Email jane.parent@home.example.test" }), ["email"]);
  assertEquals(personalDetails({ title: "Winter concert at 6:30 PM", description: "Gym, doors open 6:00. Room 12 sings first." }), []);
  assertEquals(personalDetails({ title: "Game vs Falcons", description: "Field 3, 9:00 AM, bring 2 water bottles" }), []);
});

// D40: the fixed "not sure" flag sits at 50%, so an owner who lowers their feed's auto-publish
// setting to 50-60% gets it. (The Room F wording, "This Friday" sent on a Friday, is in dates.test.ts.)
Deno.test("checkEvent: 55% isn't flagged, 45% is", async () => {
  const { checkEvent } = await import("./checks.ts");
  const input = { referenceDate: "2026-11-13T21:16:00Z", timezone: "America/Los_Angeles", feedName: "Room F", feedCategory: null,
    subject: "Dinos-giving", sender: "roomf@school.example", body: "Friday, Nov 20 is Dinos-giving! Bring a dish to share.", pages: [] };
  const ev = (confidence: number) => ({ title: "Dinos-giving", start: "2026-11-20", end: null, all_day: true, timezone: "America/Los_Angeles",
    location: null, description: null, recurrence: null, status: "new" as const, confidence, evidence_quote: "Friday, Nov 20 is Dinos-giving",
    source_ref: { kind: "body" as const, attachment_id: null, page_index: null } });
  assertEquals(checkEvent(ev(0.55), input).review, []);
  assertEquals(checkEvent(ev(0.55), input).dateConfirmed, true);
  assertEquals(checkEvent(ev(0.45), input).review, ["low_confidence"]);
});
