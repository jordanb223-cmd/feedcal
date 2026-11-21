import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildCalendar, type CalendarEvent } from "./calendar.js";
import { escapeText, foldLine } from "./text.js";
import { offsetMinutes } from "./time.js";
import { vtimezone } from "./vtimezone.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "golden");
const opts = { defaultTimeZone: "America/Los_Angeles", reportUrl: (uid: string) => `https://feedcal.example/report/${uid}`, product: "Feedcal test" };
const base = { createdAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-02T12:00:00Z", sequence: 0, status: "confirmed" as const, allDay: false };

const CASES: Record<string, { feed: { name: string; description?: string }; events: CalendarEvent[] }> = {
  // 9am Pacific the day after DST ends, plus a Kolkata event (no DST) in the same feed.
  timezone: {
    feed: { name: "Sutterville Kindergarten", description: "Class events; field trips, and more" },
    events: [
      { ...base, uid: "tz-1@feedcal.app", title: "Pumpkin patch, field trip", startsAt: "2026-11-02T17:00:00Z", endsAt: "2026-11-02T20:00:00Z", timeZone: "America/Los_Angeles", location: "Farm; Gate 2", source: "school.example.test" },
      { ...base, uid: "tz-2@feedcal.app", title: "Call with Kolkata", startsAt: "2026-11-03T04:30:00Z", endsAt: null, timeZone: "Asia/Kolkata" },
    ],
  },
  // A three-day all-day event and a one-day all-day event with no end.
  allday: {
    feed: { name: "Holidays" },
    events: [
      { ...base, uid: "ad-1@feedcal.app", title: "Thanksgiving break", allDay: true, startsAt: "2026-11-25T20:00:00Z", endsAt: "2026-11-27T20:00:00Z", timeZone: "America/Los_Angeles" },
      { ...base, uid: "ad-2@feedcal.app", title: "No school", allDay: true, startsAt: "2026-12-31T23:30:00Z", endsAt: null, timeZone: "America/Los_Angeles" },
    ],
  },
  // Weekly practice that crosses the March 2027 DST change, and one unsafe rule that must be dropped.
  recurring: {
    feed: { name: "U10 Soccer" },
    events: [
      { ...base, uid: "rr-1@feedcal.app", title: "Practice", startsAt: "2027-02-23T01:30:00Z", endsAt: "2027-02-23T03:00:00Z", timeZone: "America/Los_Angeles", rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=6" },
      { ...base, uid: "rr-2@feedcal.app", title: "Bad rule", startsAt: "2027-02-24T01:30:00Z", endsAt: null, timeZone: "America/Los_Angeles", rrule: "FREQ=DAILY\r\nATTENDEE:mailto:x@example.test" },
    ],
  },
  cancelled: {
    feed: { name: "Choir" },
    events: [{ ...base, uid: "cx-1@feedcal.app", title: "Concert", status: "cancelled", sequence: 1, startsAt: "2026-12-10T03:00:00Z", endsAt: "2026-12-10T05:00:00Z", timeZone: "America/Los_Angeles" }],
  },
  // An event edited twice: same UID, higher SEQUENCE, newer LAST-MODIFIED.
  edited: {
    feed: { name: "PTA" },
    events: [{ ...base, uid: "ed-1@feedcal.app", title: "PTA meeting (moved to the library)", sequence: 2, updatedAt: "2026-11-15T08:00:00Z", startsAt: "2026-11-18T02:00:00Z", endsAt: "2026-11-18T03:00:00Z", timeZone: "America/Los_Angeles", description: "Line one\nLine two with a \\ backslash" }],
  },
};

function build(name: keyof typeof CASES) {
  const c = CASES[name];
  if (!c) throw new Error(`no case ${name}`);
  return buildCalendar(c.feed, c.events, opts);
}

describe("golden files", () => {
  for (const name of Object.keys(CASES)) {
    it(`${name}.ics matches`, () => {
      const { ics } = build(name);
      const file = join(GOLDEN, `${name}.ics`);
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) writeFileSync(file, ics);
      expect(ics).toBe(readFileSync(file, "utf8"));
    });
  }
});

describe("validity (checked with ical.js, an independent parser)", () => {
  for (const name of Object.keys(CASES)) {
    it(`${name}: parses, uses CRLF, and keeps every line within 75 octets`, () => {
      const { ics } = build(name);
      expect(ics.endsWith("\r\n")).toBe(true);
      expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      const cal = new ICAL.Component(ICAL.parse(ics));
      expect(cal.getFirstPropertyValue("version")).toBe("2.0");
      expect(cal.getAllSubcomponents("vevent").length).toBe(CASES[name]?.events.length);
    });
  }

  it("every timed event's start resolves to the original instant through the generated VTIMEZONE", () => {
    for (const name of Object.keys(CASES)) {
      const cal = new ICAL.Component(ICAL.parse(build(name).ics));
      for (const vtz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
      for (const vevent of cal.getAllSubcomponents("vevent")) {
        const ev = new ICAL.Event(vevent);
        const src = CASES[name]?.events.find((e) => e.uid === ev.uid);
        if (!src || src.allDay) continue;
        expect(ev.startDate.toJSDate().toISOString(), `${name} ${ev.uid}`).toBe(new Date(src.startsAt).toISOString());
        if (src.endsAt) expect(ev.endDate.toJSDate().toISOString()).toBe(new Date(src.endsAt).toISOString());
      }
      for (const vtz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.remove(String(vtz.getFirstPropertyValue("tzid")));
    }
  });

  it("a weekly event keeps its local time across the DST change", () => {
    const cal = new ICAL.Component(ICAL.parse(build("recurring").ics));
    for (const vtz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
    const practice = cal.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v)).find((e) => e.uid === "rr-1@feedcal.app");
    if (!practice) throw new Error("practice missing");
    const it6 = practice.iterator();
    const utcHours: number[] = [];
    for (let next = it6.next(); next; next = it6.next()) utcHours.push(next.toJSDate().getUTCHours());
    ICAL.TimezoneService.remove("America/Los_Angeles");
    // 5:30pm Pacific: 01:30 UTC in winter (PST), 00:30 UTC after the March change (PDT).
    expect(utcHours).toEqual([1, 1, 1, 0, 0, 0]);
  });
});

describe("behaviour", () => {
  it("drops an unsafe RRULE and says so", () => {
    const { ics, warnings } = build("recurring");
    expect(ics).not.toContain("ATTENDEE");
    expect(warnings).toEqual(["dropped invalid RRULE on rr-2@feedcal.app"]);
  });

  it("all-day events use DATE values and an exclusive end, in the event's zone", () => {
    const { ics } = build("allday");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261128");
    // 23:30 UTC on Dec 31 is still Dec 31 in Los Angeles.
    expect(ics).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");
  });

  it("cancelled events stay in the feed with STATUS:CANCELLED", () => {
    expect(build("cancelled").ics).toContain("STATUS:CANCELLED");
  });

  it("an edit keeps the UID and raises SEQUENCE", () => {
    const { ics } = build("edited");
    expect(ics).toContain("UID:ed-1@feedcal.app");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("LAST-MODIFIED:20261115T080000Z");
  });

  it("the description carries the source line and the report link", () => {
    const { ics } = build("timezone");
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("Source: forwarded email from school.example.test\\n\\nReport a problem: https://feedcal.example/report/tz-1@feedcal.app");
  });

  it("is deterministic: the same data gives byte-identical output", () => {
    expect(build("timezone").ics).toBe(build("timezone").ics);
  });

  it("an unknown time zone falls back to the default and warns", () => {
    const r = buildCalendar({ name: "x" }, [{ ...base, uid: "u@feedcal.app", title: "t", startsAt: "2026-11-02T17:00:00Z", timeZone: "Mars/Olympus" }], opts);
    expect(r.ics).toContain("DTSTART;TZID=America/Los_Angeles:20261102T090000");
    expect(r.warnings).toEqual(["unknown time zone on u@feedcal.app; used America/Los_Angeles"]);
  });
});

describe("text", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("folds at 75 octets without splitting UTF-8 characters", () => {
    const line = "SUMMARY:" + "é".repeat(60) + "🎃".repeat(10);
    const folded = foldLine(line);
    const enc = new TextEncoder();
    for (const part of folded.split("\r\n")) expect(enc.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
    expect(folded).not.toContain("�");
  });

  it("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });
});

describe("VTIMEZONE change times", () => {
  // US rules: clocks go from 2:00 to 3:00 in March, and from 2:00 back to 1:00 in November.
  // DTSTART is the local time of the change in the offset before it: 02:00 both times.
  const lines = vtimezone("America/Los_Angeles", 2026, 2026);
  const block = (kind: string, from: string) => {
    const i = lines.findIndex((l, j) => l === `BEGIN:${kind}` && lines[j + 2] === `TZOFFSETFROM:${from}`);
    return lines.slice(i, i + 4);
  };

  it("spring forward starts at 02:00 local standard time", () => {
    expect(block("DAYLIGHT", "-0800")).toEqual(["BEGIN:DAYLIGHT", "DTSTART:20260308T020000", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700"]);
  });

  it("fall back starts at 02:00 local daylight time", () => {
    expect(block("STANDARD", "-0700")).toEqual(["BEGIN:STANDARD", "DTSTART:20261101T020000", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800"]);
  });

  it("southern-hemisphere and half-hour zones get the right change times (Sydney, Adelaide)", () => {
    // Sydney: first Sunday of April 03:00 AEDT -> 02:00 AEST; first Sunday of October 02:00 -> 03:00.
    const syd = vtimezone("Australia/Sydney", 2026, 2026);
    expect(syd).toContain("DTSTART:20260405T030000");
    expect(syd).toContain("DTSTART:20261004T020000");
    // Adelaide is +09:30 / +10:30 with the same change days.
    const adl = vtimezone("Australia/Adelaide", 2026, 2026);
    expect(adl).toContain("TZOFFSETTO:+1030");
    expect(adl).toContain("DTSTART:20261004T020000");
  });

  it("an event in the hour after a change resolves to the right instant", () => {
    // 03:30 PDT on the March 2026 change day is 10:30 UTC.
    const r = buildCalendar({ name: "x" }, [{ ...base, uid: "edge@feedcal.app", title: "Early", startsAt: "2026-03-08T10:30:00Z", timeZone: "America/Los_Angeles" }], opts);
    const cal = new ICAL.Component(ICAL.parse(r.ics));
    for (const vtz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
    const ev = new ICAL.Event(cal.getFirstSubcomponent("vevent") ?? undefined);
    expect(r.ics).toContain("DTSTART;TZID=America/Los_Angeles:20260308T033000");
    expect(ev.startDate.toJSDate().toISOString()).toBe("2026-03-08T10:30:00.000Z");
    ICAL.TimezoneService.remove("America/Los_Angeles");
  });
});

describe("time zone data", () => {
  it("knows Pacific time's offsets on both sides of the November 2026 change", () => {
    expect(offsetMinutes(Date.parse("2026-11-01T08:00:00Z"), "America/Los_Angeles")).toBe(-420);
    expect(offsetMinutes(Date.parse("2026-11-01T10:00:00Z"), "America/Los_Angeles")).toBe(-480);
  });
});

describe("EXDATE (one occurrence of a series removed, Phase 10)", () => {
  const series: CalendarEvent = { ...base, uid: "ex-1@feedcal.app", title: "Practice", startsAt: "2026-12-02T01:00:00Z", endsAt: "2026-12-02T02:15:00Z",
    timeZone: "America/Los_Angeles", rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=4", exdates: ["2026-12-09T01:00:00Z"] };

  it("writes EXDATE in DTSTART's zone, and ical.js skips that occurrence", () => {
    const { ics } = buildCalendar({ name: "Team" }, [series], opts);
    expect(ics).toContain("EXDATE;TZID=America/Los_Angeles:20261208T170000");
    const cal = new ICAL.Component(ICAL.parse(ics));
    for (const vtz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
    const event = new ICAL.Event(cal.getFirstSubcomponent("vevent") ?? undefined);
    const it = event.iterator();
    const starts: string[] = [];
    for (let next = it.next(); next; next = it.next()) starts.push(next.toJSDate().toISOString());
    expect(starts).toEqual(["2026-12-02T01:00:00.000Z", "2026-12-16T01:00:00.000Z", "2026-12-23T01:00:00.000Z"]);
  });

  it("all-day series use DATE values; events without RRULE never get EXDATE", () => {
    const allDay = buildCalendar({ name: "T" }, [{ ...series, allDay: true, uid: "ex-2@feedcal.app", startsAt: "2026-12-01T20:00:00Z", endsAt: null, exdates: ["2026-12-08T20:00:00Z"] }], opts).ics;
    expect(allDay).toContain("EXDATE;VALUE=DATE:20261208");
    const single = buildCalendar({ name: "T" }, [{ ...series, rrule: null }], opts).ics;
    expect(single).not.toContain("EXDATE");
  });
});
