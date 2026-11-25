import { describe, expect, it } from "vitest";
import { leftOutOf, snippet } from "./review.js";
import { feedHomePage, isSure, whenRange, whyWaiting, type DraftCard, type EmailGroup, type ReviewCard } from "./review-views.js";

const card = (over: Partial<ReviewCard> = {}): ReviewCard => ({
  id: "c1", title: "Walkathon", when: { starts_at: "2026-11-23T18:00:00Z", all_day: false, timezone: "America/Los_Angeles" }, location: null,
  confidence: 0.75, outcome: "update", changeKind: "changed", reviewReasons: ["low_confidence"],
  existing: { title: "Walkathon", starts_at: "2026-11-22T18:00:00Z", all_day: false, timezone: "America/Los_Angeles" },
  evidence: { before: "If it rains, ", quote: "the walkathon moves to Sunday", after: " at 10 AM.", where: "email: Walkathon" },
  imageUrl: null, originalUrl: null, date: "2026-11-23", time: "10:00", ...over,
});

describe("snippet", () => {
  it("finds the quote despite curly quotes and case, and keeps context", () => {
    expect(snippet("Hello. Join “Family Night” on Friday at 6 PM. Bye.", '"family night" on friday at 6 pm')).toEqual({
      before: "Hello. Join ", quote: "“Family Night” on Friday at 6 PM", after: ". Bye." });
  });
  it("falls back to the quote alone", () => {
    expect(snippet(null, "x y z")).toEqual({ before: "", quote: "x y z", after: "" });
  });
});

describe("review cards", () => {
  it("label 'Sure' only for confident items with no warnings, never conflicts", () => {
    expect(isSure({ confidence: 0.9, reviewReasons: [], outcome: "new" })).toBe(true);
    expect(isSure({ confidence: 0.9, reviewReasons: ["from_transcription"], outcome: "new" })).toBe(false);
    expect(isSure({ confidence: 0.95, reviewReasons: [], outcome: "conflict" })).toBe(false);
  });

  it("shows before → after, the highlighted quote, and escapes email text", async () => {
    const html = String(await feedHomePage({ csrf: "t", feedId: "f", name: "Room 12", drafts: [], upcoming: [],
      cards: [card({ evidence: { before: "<script>x</script> ", quote: "moves to Sunday", after: "", where: "email" } })] }));
    expect(html).toContain("Needs you");
    expect(html).toContain("Yes, change it");
    expect(html).toContain("Sun, Nov 22 · 10:00 AM PST → <strong>Mon, Nov 23 · 10:00 AM PST</strong>");
    expect(html).toContain("<mark>moves to Sunday</mark>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("Why it's waiting: It changes something already on your calendar");
  });

  it("warns loudly about possible injection and offers 'approve all Sure' only when something is sure", async () => {
    const html = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", drafts: [], upcoming: [],
      cards: [card({ reviewReasons: ["possible_injection"], confidence: 0.99, outcome: "new" })] }));
    expect(html).toContain('class="error">This email contains text aimed at the AI');
    expect(html).not.toContain("Calantern is sure about");
    // One sure item needs no "add them all" button; two do.
    const one = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", drafts: [], upcoming: [], cards: [card({ reviewReasons: [], confidence: 0.9, outcome: "new" })] }));
    expect(one).not.toContain("Calantern is sure about");
    const two = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", drafts: [], upcoming: [],
      cards: [card({ reviewReasons: [], confidence: 0.9, outcome: "new" }), card({ id: "c2", reviewReasons: [], confidence: 0.9, outcome: "new" })] }));
    expect(two).toContain("Add the 2 Calantern is sure about");
  });

  it("has an empty state", async () => {
    const html = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", cards: [], drafts: [], upcoming: [] }));
    expect(html).toContain("Nothing needs you.");
    expect(html).not.toContain('class="mailcard');
    expect(html).toContain("No upcoming events yet.");
  });
});

// D81: one card per email.
describe("review page grouped by email", () => {
  const WHEN = { starts_at: "2026-11-26T20:00:00Z", ends_at: "2026-11-27T20:00:00Z", all_day: true, timezone: "America/Los_Angeles" };
  const draft = (over: Partial<DraftCard> = {}): DraftCard => ({ id: "d1", messageId: "m1", title: "No school", when: WHEN, location: null, confidence: 0.4, quote: "NOVEMBER 26 & 27 – NO SCHOOL", reviewReasons: [], fromPicture: true, ...over });
  const email = (over: Partial<EmailGroup> = {}): EmailGroup => ({
    id: "m1", subject: "TGIF <b>", sender: "teacher@school.example", received: "Sat, Nov 21",
    added: [{ id: "e1", title: "Share Day", when: { starts_at: "2026-11-25T20:00:00Z", all_day: true, timezone: "America/Los_Angeles" }, location: null, status: "confirmed" }],
    leftOut: { named: [{ title: "Dinosgiving", when: "Fri, Nov 20", why: "the date has passed" }], others: 1 }, ...over,
  });
  const page = async (o: { cards?: ReviewCard[]; drafts?: DraftCard[]; emails?: EmailGroup[] }) =>
    String(await feedHomePage({ csrf: "t", feedId: "f", name: "Room F", cards: o.cards ?? [], drafts: o.drafts ?? [], emails: o.emails ?? [], upcoming: [], bar: 0.45 }));

  it("puts what needs the owner, what was added and what was left out under their email", async () => {
    const html = await page({ drafts: [draft()], emails: [email()] });
    expect(html).toContain("<strong>1 thing needs you.</strong>");
    expect((html.match(/<article class="mailcard">/g) ?? []).length).toBe(1);
    expect(html).toContain("TGIF &lt;b&gt;");
    expect(html).toContain("Calantern <strong>added 1 event</strong> and is <strong>unsure about 1</strong>.");
    expect(html).toContain("<strong>Thu, Nov 26 to Fri, Nov 27</strong> · All day");
    expect(html).toContain("Why it's waiting: This was read from a picture, and Calantern was 40% sure. Pictures need 45% to go on by themselves.");
    expect(html).toContain('action="/feeds/f/drafts/d1/publish"');
    expect(html).toContain("Yes, add it");
    expect(html).toContain("Not an event");
    expect(html).toContain("Added to your calendar");
    expect(html).toContain("2 left out");
    expect(html).toContain("Dinosgiving</span>, Fri, Nov 20: the date has passed");
    expect(html).toContain("1 other that didn't pass Calantern's checks");
    // One question, one dark button.
    expect((html.match(/<button type="submit">/g) ?? []).length).toBe(1);
  });

  it("an email that needs nothing is one folded line; one that did nothing is not shown", async () => {
    const html = await page({ emails: [email(), email({ id: "m2", subject: "Empty", added: [], leftOut: { named: [], others: 0 } })] });
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain('<details class="mailcard quiet">');
    expect(html).toContain("Sat, Nov 21 · added 1");
    expect(html).not.toContain("Empty");
  });

  it("something waiting whose email isn't listed still shows, under its own heading", async () => {
    const html = await page({ drafts: [draft({ messageId: null })] });
    expect(html).toContain("Found earlier");
    expect(html).toContain("Yes, add it");
  });

  it("D85: two or more new events waiting get one 'Add all' button; one does not", async () => {
    const two = await page({ drafts: [draft(), draft({ id: "d2", title: "Book fair" })], emails: [email()] });
    expect(two).toContain('action="/feeds/f/add-all"');
    expect(two).toContain('name="drafts" value="d1,d2"');
    expect(two).toContain("Add all 2");
    // Each one keeps its own buttons.
    expect(two).toContain('action="/feeds/f/drafts/d2/publish"');
    const one = await page({ drafts: [draft()], emails: [email()] });
    expect(one).not.toContain("/add-all");
  });

  it("D88: a follower's question shows with an answer box and a hide button; none, no section", async () => {
    const q = { id: "q1", body: "Packed lunch? <i>", asked: "Nov 24", eventId: "e9", eventTitle: "Field trip", when: WHEN };
    const html = String(await feedHomePage({ csrf: "t", feedId: "f", name: "Room F", cards: [], drafts: [], emails: [], upcoming: [], questions: [q] }));
    expect(html).toContain("A follower asked a question");
    expect(html).toContain("Packed lunch? &lt;i&gt;");
    expect(html).toContain('action="/feeds/f/questions/q1/answer"');
    expect(html).toContain('action="/feeds/f/questions/q1/hide"');
    expect(html).toContain("Only you can see these.");
    expect(await page({})).not.toContain("asked a question");
  });

  it("explains the wait in one sentence", () => {
    expect(whyWaiting({ confidence: 0.6 }, 0.7)).toBe("Calantern was 60% sure. It needs 70% to add something by itself.");
    expect(whyWaiting({ confidence: 0.4, fromPicture: true }, 0.45)).toContain("Pictures need 45%");
    expect(whyWaiting({ confidence: 0.8, fromPicture: true }, 0.9)).toContain("Pictures need 90%");
    expect(whyWaiting({ confidence: 0.9, reviewReasons: ["ambiguous_date"] }, 0.7)).toContain("fits more than one date");
    expect(whyWaiting({ confidence: 0.9, outcome: "conflict" }, 0.7)).toContain("read this email again");
    expect(whyWaiting({ confidence: 0.95 }, 0.7)).toBe("Calantern is 95% sure, but held this back to be safe.");
    expect(whyWaiting({ confidence: null }, 0.7)).toBe("Calantern wasn't sure enough to add this by itself.");
  });

  it("shows a date range only when the event runs past its first day", () => {
    expect(whenRange(WHEN)).toBe("Thu, Nov 26 to Fri, Nov 27 · All day");
    expect(whenRange({ ...WHEN, ends_at: null })).toBe("Thu, Nov 26 · All day");
    expect(whenRange({ ...WHEN, ends_at: WHEN.starts_at })).toBe("Thu, Nov 26 · All day");
  });

  it("names only the items left out for their date, and counts the rest", () => {
    const l = leftOutOf({ rejected: [
      { event: { title: "Old party", start: "2026-11-20" }, reason: "already_past" },
      { event: { title: "Made up", start: "2026-12-01" }, reason: "quote_not_found" },
      { event: { title: 5 }, reason: "already_past" },
    ] }, "America/Los_Angeles");
    expect(l).toEqual({ named: [{ title: "Old party", when: "Fri, Nov 20", why: "the date has passed" }], others: 2 });
    expect(leftOutOf(null, "UTC")).toEqual({ named: [], others: 0 });
    expect(leftOutOf({ rejected: "x" }, "UTC")).toEqual({ named: [], others: 0 });
  });
});
