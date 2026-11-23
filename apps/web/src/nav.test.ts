// Every organizer page of a feed has a way back: the feed menu (found missing on the Share page,
// 2026-11-21).
import { describe, expect, it } from "vitest";
import { emailSetupPage } from "./email-views.js";
import { shareKitPage } from "./subscribe-views.js";

const ID = "6dc8d67e-7490-4ffd-b718-4b4eed87274c";

describe("feed menu", () => {
  it("the Share page links back to the feed and to all feeds", async () => {
    const html = String(await shareKitPage({ csrf: "t", feedId: ID, name: "Room F", visibility: "unlisted", pageUrl: "https://x/c/room-f",
      feedUrl: "https://x/f/tok.ics", qrSvg: "<svg></svg>", chatText: "hi", stats: null }));
    expect(html).toContain('<a href="/feeds">Your calendars</a>'); // the way back is the site header
    expect(html).not.toContain("Gmail</a>"); // five tabs that fit a phone; Gmail is reached from Email
    expect(html).toContain(`<a href="/feeds/${ID}">Review</a>`);
    expect(html).toContain('<strong aria-current="page">Share</strong>');
  });

  it("the Email page has the same menu", async () => {
    const html = String(await emailSetupPage({ csrf: "t", feedId: ID, name: "Room F", isOwner: true, address: null, localPart: "feed-x",
      confirmation: null, senders: [], suspicious: [] }));
    expect(html).toContain('<a href="/feeds">Your calendars</a>'); // the way back is the site header
    expect(html).not.toContain("Gmail</a>"); // five tabs that fit a phone; Gmail is reached from Email
    expect(html).toContain('<strong aria-current="page">Email</strong>');
  });
});
