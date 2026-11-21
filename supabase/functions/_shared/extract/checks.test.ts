import { assertEquals } from "jsr:@std/assert@1";
import { personalDetails } from "./checks.ts";

Deno.test("personal details in event text are found; venues and times are not", () => {
  assertEquals(personalDetails({ title: "Pickup from Sam's house", description: "Call (916) 555-0142 or text 916.555.0142" }), ["phone"]);
  assertEquals(personalDetails({ title: "Carpool", description: "Meet at 1428 Maple Drive" }), ["street_address"]);
  assertEquals(personalDetails({ title: "RSVP", description: "Email jane.parent@home.example.test" }), ["email"]);
  assertEquals(personalDetails({ title: "Winter concert at 6:30 PM", description: "Gym, doors open 6:00. Room 12 sings first." }), []);
  assertEquals(personalDetails({ title: "Game vs Falcons", description: "Field 3, 9:00 AM, bring 2 water bottles" }), []);
});
