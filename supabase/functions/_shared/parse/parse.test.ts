// Phase 7 "passes when": every fixture parses into the expected clean text and attachment list,
// with no logos kept. Expectations are written from what each email means, not copied from output.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseMessage } from "./parse.ts";
import { htmlToText } from "./html-to-text.ts";
import { imageSize } from "./images.ts";
import { detectLanguage } from "./language.ts";
import { parseLooseDate } from "./forward.ts";

interface Expect {
  source?: "text" | "html" | "none";
  sender?: string;
  subject?: string;
  referenceDate?: string;
  refSource?: "forwarded_header" | "date_header" | "received";
  depth?: number;
  notes?: string[];
  language?: string;
  contains?: string[];
  notContains?: string[];
  stripped?: string[];
  attachments: string[];
  discarded?: string[];
}

const RECEIVED = "2026-11-20T00:00:00.000Z";
const NOISE = ["maple-logo", "facebook.png", "Preheader", "track.example.test", "<", "&nbsp;", "&ndash;"];

const EXPECT: Record<string, Expect> = {
  "01-school-newsletter-html": {
    source: "html", sender: "office@maplegrove.example.test", subject: "Maple Grove News: November", language: "en",
    refSource: "date_header", referenceDate: "2026-11-14T23:30:00.000Z",
    contains: ["November News", "Date | Event | Time\nNov 21 | Picture day | 8:30 AM\nNov 26–28", "Nov 26–28 | Thanksgiving break, no school", "Book fair (https://maplegrove.example.test/bookfair)"],
    notContains: [...NOISE, "View this email in your browser", "social.example.test"],
    attachments: [], discarded: ["maple-logo.png", "facebook.png"],
  },
  "02-sports-schedule-table": {
    source: "html", sender: "dana@riverleague.example.test",
    contains: ["Date | Opponent | Field | Kickoff", "Sat Oct 18 | Falcons | McKinley Park #3 | 9:00 AM", "Sat Nov 1 | Comets | McKinley Park #2 | 8:00 AM", "Questions? dana@riverleague.example.test"],
    notContains: ["mailto:"], attachments: [],
  },
  "03-appointment-reminder": {
    source: "text", contains: ["Tuesday, December 2 at 3:45 PM", "Please arrive 10 minutes early."],
    notContains: ["1200 Elm Street", "(555) 010-2299"], stripped: ["Riverside Pediatrics", "(555) 010-2299"], attachments: [],
  },
  "04-venue-list": {
    source: "text", contains: ["- Sat Dec 6, warm-ups 7:30 AM: Northside Aquatic Center, 400 Pool Rd", "Sun Feb 8", "https://lakesideswim.example.test/carpool"], attachments: [],
  },
  "05-flyer-image-only": {
    source: "none", language: "und", contains: [], attachments: ["fall-festival-flyer.jpg"], discarded: ["pta-logo.png"],
  },
  "06-pdf-only": { source: "text", contains: ["See attached."], attachments: ["December-calendar.pdf"] },
  "07-gmail-forward-plain": {
    sender: "dana@riverleague.example.test", subject: "Practice schedule", depth: 1, notes: ["Can you add these?"],
    refSource: "forwarded_header", referenceDate: "2026-11-17T17:14:00.000Z",
    contains: ["Practices are Tuesdays and Thursdays 5:00-6:15 PM"], notContains: ["Forwarded message", "Can you add these?", "To: Hawks"], attachments: [],
  },
  "08-outlook-forward-html": {
    source: "html", sender: "patel@maplegrove.example.test", subject: "Winter concert", depth: 1, notes: ["Adding this one."],
    refSource: "forwarded_header", referenceDate: "2026-11-17T14:14:00.000Z",
    contains: ["The winter concert is Thursday, December 11 at 6:30 PM in the gym."], notContains: ["Sent:", "Adding this one."], attachments: [],
  },
  "09-apple-mail-forward": {
    sender: "library@oakstreet.example.test", subject: "Library volunteer shifts", depth: 1, notes: ["FYI"],
    refSource: "forwarded_header", referenceDate: "2026-11-17T17:14:02.000Z",
    contains: ["Shifts for December: Mondays 1-3 PM and Fridays 9-11 AM"], notContains: ["Begin forwarded message"], attachments: [],
  },
  "10-forwarded-chain": {
    sender: "chen@maplegrove.example.test", subject: "Winter concert schedule", depth: 2, notes: ["For the calendar", "Sending this along"],
    refSource: "forwarded_header", referenceDate: "2026-11-17T04:00:00.000Z",
    contains: ["Grade 3 performs at 7:15 PM on December 11."], notContains: ["Sam Rivera", "Sending this along", "____"], attachments: [],
  },
  "11-reply-changed-time": {
    sender: "dana@riverleague.example.test", subject: "Thursday practice", depth: 0,
    contains: ["Thursday practice moves to 6:00 PM"], notContains: ["5:00 PM", "wrote:"], stripped: ["Practice is Thursday at 5:00 PM"], attachments: [],
  },
  "12-forward-as-attachment": {
    sender: "patel@maplegrove.example.test", subject: "Field trip permission", depth: 1, notes: ["FYI"],
    refSource: "date_header", referenceDate: "2026-11-17T17:14:00.000Z",
    contains: ["Bus leaves at 8:45 AM"], attachments: ["permission-slip.pdf"],
  },
  "13-quoted-printable-html": { source: "html", contains: ["Join us for Café night on Friday, November 21 from 6:00 to 8:00 PM in the cafeteria. Hot cocoa is $1."], attachments: [] },
  "14-latin1-french": { subject: "Réunion des parents", language: "fr", contains: ["Réunion des parents le mardi 18 novembre à 18h30"], attachments: [] },
  "15-spanish-newsletter": { language: "es", contains: ["La feria de ciencias será el jueves 20 de noviembre"], attachments: [] },
  "16-hebrew-rtl": { language: "he", contains: ["מסיבת חנוכה תתקיים ביום רביעי, 17 בדצמבר"], attachments: [] },
  "17-calendar-invite": { contains: ["Saturday November 22, 4-6 PM"], attachments: ["invite.ics"] },
  "18-inline-photo-kept": {
    source: "html", contains: ["Our bake sale is this Saturday, November 15, 9 AM to noon at the front entrance."],
    attachments: ["bake-sale-poster.jpg"], discarded: ["spacer.gif"],
  },
  "19-tracking-and-hidden": {
    source: "html", contains: ["Register here (https://cityrec.example.test/register?utm_source=email)", "visit https://cityrec.example.test."],
    notContains: ["Secret preheader", "Hidden block", "alert(1)", "pixel.example.test"], attachments: [],
  },
  "20-mobile-signature": { contains: ["Today's game moved to Riverside field 2, same time (10:30 AM)."], notContains: ["Sent from my iPhone"], stripped: ["Sent from my iPhone"], attachments: [] },
  "21-outlook-reply-not-forward": {
    sender: "chair@oakstreet.example.test", subject: "Bake sale", depth: 0, refSource: "date_header",
    contains: ["Yes, we still need 3 volunteers for Saturday 9 AM."], notContains: ["8 AM", "____"], stripped: ["Do you still need help on Saturday at 8 AM?"], attachments: [],
  },
  "22-duplicate-attachments": { contains: ["December lunch menu attached."], attachments: ["lunch-menu.pdf"] },
  "23-winmail-and-vcard": { attachments: ["conference-slots.pdf"], discarded: ["winmail.dat", "Front Office.vcf"], contains: ["Parent-teacher conferences are November 24 and 25."] },
  "24-base64-text": { source: "text", contains: ["The November camping trip is the weekend of November 14-16 at Pine Lake."], attachments: [] },
  "25-html-layout-tables": {
    source: "html", contains: ["Winter Recital\n\nSunday, December 14 at 2:00 PM, Hillside Community Hall.", "Piano students | 2:00 PM\nViolin students | 3:15 PM", "Doors open at 1:30 PM."],
    notContains: ["Hall. | ", "Recital | "], attachments: [],
  },
  "26-outlook-mobile-numeric-date": {
    sender: "rivera@maplegrove.example.test", subject: "Field trip forms", depth: 1, notes: ["Please see below"],
    refSource: "forwarded_header", referenceDate: "2026-11-17T15:14:00.000Z",
    contains: ["Forms are due Friday, November 21. The trip is December 3."], attachments: [],
  },
};

const dir = new URL("./fixtures/", import.meta.url);
const files = [...Deno.readDirSync(dir)].filter((f) => f.name.endsWith(".eml")).map((f) => f.name.replace(/\.eml$/, "")).sort();

Deno.test("there are at least 25 fixtures, and each has expectations", () => {
  assert(files.length >= 25, `only ${files.length} fixtures`);
  assertEquals(files, Object.keys(EXPECT).sort());
});

for (const name of files) {
  Deno.test(`fixture ${name}`, async () => {
    const e = EXPECT[name]!;
    const { parsed, files: stored } = await parseMessage(await Deno.readFile(new URL(`${name}.eml`, dir)), { receivedAt: RECEIVED });
    const where = `${name}: cleanText was\n${parsed.cleanText}\n---`;
    if (e.source) assertEquals(parsed.bodySource, e.source, where);
    if (e.sender) assertEquals(parsed.sender?.address, e.sender, where);
    if (e.subject) assertEquals(parsed.subject, e.subject);
    if (e.referenceDate) assertEquals(parsed.referenceDate, e.referenceDate);
    if (e.refSource) assertEquals(parsed.referenceDateSource, e.refSource);
    if (e.depth !== undefined) assertEquals(parsed.forwardDepth, e.depth, where);
    if (e.notes) assertEquals(parsed.forwardNotes, e.notes);
    if (e.language) assertEquals(parsed.language, e.language, where);
    for (const s of e.contains ?? []) assert(parsed.cleanText.includes(s), `${where}\nmissing: ${JSON.stringify(s)}`);
    for (const s of e.notContains ?? []) assert(!parsed.cleanText.includes(s), `${where}\nshould not contain: ${JSON.stringify(s)}`);
    for (const s of e.stripped ?? []) assert(parsed.strippedText.includes(s), `${name}: stripped was\n${parsed.strippedText}\nmissing: ${s}`);
    assertEquals(parsed.attachments.map((a) => a.filename), e.attachments, `${name} attachments`);
    assertEquals(stored.map((f) => f.filename), e.attachments, `${name} stored files`);
    if (e.discarded) assertEquals(parsed.discarded.map((d) => d.filename).sort(), [...e.discarded].sort());
    // No logos, icons or spacers survive anywhere.
    for (const a of parsed.attachments) assert(!/logo|icon|facebook|spacer/i.test(a.filename ?? ""), `${name} kept ${a.filename}`);
  });
}

Deno.test("image sizes are read from headers", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 2, 0x58]);
  assertEquals(imageSize(png), { width: 800, height: 600 });
  assertEquals(imageSize(new TextEncoder().encode("not an image")), null);
});

Deno.test("html: nested lists, line breaks, entity decoding", () => {
  assertEquals(htmlToText("<ul><li>One</li><li>Two &amp; three</li></ul><p>a<br>b</p>"), "- One\n- Two & three\n\na\nb");
});

Deno.test("language: short or mixed text is undetermined", () => {
  assertEquals(detectLanguage("OK"), "und");
  assertEquals(detectLanguage("The game is on Saturday and you will need your uniform for the photos."), "en");
});

Deno.test("dates: forms each client writes, with and without a zone", () => {
  assertEquals(parseLooseDate("Mon, Nov 17, 2026 at 9:14 AM", -480), "2026-11-17T17:14:00.000Z");
  assertEquals(parseLooseDate("Monday, November 17, 2026 12:05 PM", 0), "2026-11-17T12:05:00.000Z");
  assertEquals(parseLooseDate("November 17, 2026 at 12:30:00 AM EST", 0), "2026-11-17T05:30:00.000Z");
  assertEquals(parseLooseDate("Mon, 17 Nov 2026 09:14:00 +0100", 0), "2026-11-17T08:14:00.000Z");
  assertEquals(parseLooseDate("11/17/2026 9:14 PM", -360), "2026-11-18T03:14:00.000Z");
  assertEquals(parseLooseDate("sometime next week", 0), null);
});
