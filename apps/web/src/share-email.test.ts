// D93: "Email it" on the Share page opens the organizer's own mail app. Bumpdraft sends nothing.
import { describe, expect, it } from "vitest";
import { APP_JS } from "./assets.js";
import { inviteMailto, shareKitPage } from "./subscribe-views.js";

const kit = { csrf: "x", feedId: "aaaaaaaa-0000-4000-8000-000000000001", name: "Room F & friends", visibility: "unlisted" as const, pageUrl: "https://bumpdraft.test/c/room-f", feedUrl: "webcal://x/f/tok.ics", qrSvg: "<svg></svg>", chatText: "", stats: null };

describe("Email it (D93)", () => {
  it("the link carries a subject and a message with the share link, and no address", () => {
    const url = new URL(inviteMailto("Room F & friends", "https://bumpdraft.test/c/room-f"));
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("");
    expect(url.searchParams.get("subject")).toBe("Add Room F & friends to your phone's calendar");
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("https://bumpdraft.test/c/room-f");
    expect(body).toContain("it can make mistakes");
    expect(body).toContain("\r\n\r\n");
    expect(body).toContain("1. Tap the link below.\r\n2. Tap the subscribe button on the page.");
    expect(body).toContain("3. That's it. New dates and changes show up on their own from then on.");
  });

  it("a private calendar's steps skip the page, because the link opens the calendar app itself", () => {
    const body = new URL(inviteMailto("Room F", "webcal://x/f/tok.ics", true)).searchParams.get("body") ?? "";
    expect(body).toContain("2. Your calendar app opens and asks if you want to subscribe. Say yes.");
    expect(body).not.toContain("subscribe button");
  });

  it("the Share page shows the section, with an address box that is never posted anywhere", async () => {
    const html = String(await shareKitPage(kit));
    expect(html).toContain("<h2>Email it</h2>");
    expect(html).toMatch(/<input id="invite-to" type="email" multiple[^>]*>/);
    expect(html).not.toMatch(/<input id="invite-to"[^>]* name=/);
    expect(html).toMatch(/<a class="button secondary" href="mailto:\?subject=[^"]+" data-mailto="invite-to">Open my email app<\/a>/);
    expect(html).toContain("Bumpdraft doesn't see or keep the address.");
    expect(html.indexOf("Group chat message")).toBeLessThan(html.indexOf("Email it"));
  });

  it("a private calendar's message carries the calendar link", async () => {
    const html = String(await shareKitPage({ ...kit, visibility: "private", pageUrl: null }));
    expect(html).toContain(encodeURIComponent("webcal://x/f/tok.ics"));
  });

  it("the page script fills the To line from the box, in the browser only", () => {
    expect(APP_JS).toContain('target.closest("a[data-mailto]")');
    expect(APP_JS).toContain("split(/[\\s,;]+/)");
  });
});
