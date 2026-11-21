import { describe, expect, it } from "vitest";
import { snippet } from "./review.js";
import { feedHomePage, isSure, type ReviewCard } from "./review-views.js";

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
    expect(html).toContain("Check this");
    expect(html).toContain("Sun, Nov 22 · 10:00 AM PST → <strong>Mon, Nov 23 · 10:00 AM PST</strong>");
    expect(html).toContain("<mark>moves to Sunday</mark>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("Feedcal isn&#39;t sure");
  });

  it("warns loudly about possible injection and offers 'approve all Sure' only when something is sure", async () => {
    const html = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", drafts: [], upcoming: [],
      cards: [card({ reviewReasons: ["possible_injection"], confidence: 0.99, outcome: "new" })] }));
    expect(html).toContain('class="error">This email contains text aimed at the AI');
    expect(html).not.toContain("Approve all");
    const sure = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", drafts: [], upcoming: [], cards: [card({ reviewReasons: [], confidence: 0.9, outcome: "new" })] }));
    expect(sure).toContain("Approve all 1 marked Sure");
  });

  it("has an empty state", async () => {
    const html = String(await feedHomePage({ csrf: "t", feedId: "f", name: "R", cards: [], drafts: [], upcoming: [] }));
    expect(html).toContain("Nothing to review.");
    expect(html).toContain("No upcoming events yet.");
  });
});
