// D60: generated attacks on the calendar file, judged by Mozilla's ical.js (Thunderbird's parser):
// every text field x control characters, injection strings, very long text; extreme dates; bad
// repeat rules. The feed must always parse, keep its events, gain no properties, and build fast.
import { expect, it } from "vitest";
import ICAL from "ical.js";
import { buildCalendar, type CalendarEvent } from "./calendar.js";

const CONTROLS = [...Array(32).keys()].filter((c) => c !== 9).map((c) => String.fromCharCode(c)).concat(["\x7f", "\x85", " ", " ", "﻿", "\ud800", "\udfff"]);
const INJECT = ["\r\nBEGIN:VEVENT\r\nSUMMARY:pwn\r\nEND:VEVENT", "\nATTENDEE:mailto:x@evil.example", "\rDTSTART:20000101T000000Z", "\\nX-INJECT:1", ";X-INJECT=1", ",", "\\", "\\\r\nX-INJECT:1",
  "\r\n X-FOLD-INJECT", "END:VCALENDAR", "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR", " X-INJECT:1", "\x85X-INJECT:1", "\x0bX-INJECT:1", "\x0cX-INJECT:1", "\x00X", "%0d%0aX-INJECT:1", "&#13;&#10;X-INJECT:1"];
const LONG = ["é".repeat(5000), "👨‍👩‍👧‍👦".repeat(800), "á".repeat(3000), "x".repeat(20000), "😀\ud800😀".repeat(200)];
const PAYLOADS = [...CONTROLS.map((c) => `A${c}B`), ...INJECT, ...LONG];
const FIELDS = ["title", "location", "description", "uid", "feedName", "feedDescription", "source"] as const;
const ALLOWED = new Set(["UID", "DTSTAMP", "SUMMARY", "DTSTART", "DTEND", "RRULE", "EXDATE", "LOCATION", "DESCRIPTION", "STATUS", "SEQUENCE", "CREATED", "LAST-MODIFIED", "TRANSP", "URL", "CLASS"]);
const base = (): CalendarEvent => ({ uid: "e1@feedcal.app", title: "Picture day", description: "Bring a smile", location: "Gym", startsAt: "2026-12-05T16:30:00Z", endsAt: null,
  allDay: false, timeZone: "America/Los_Angeles", status: "confirmed", sequence: 0, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", source: "school.example" });

it("survives every generated attack on its text fields, dates and rules", () => {
  const problems: Record<string, string[]> = {};
  const add = (kind: string, what: string) => (problems[kind] ??= []).length < 6 && problems[kind].push(what);
  let n = 0;
  for (const field of FIELDS) for (const p of PAYLOADS) {
    n++;
    const ev = base(); const feed = { name: "Room F", description: "Class calendar" as string | null };
    if (field === "feedName") feed.name = p; else if (field === "feedDescription") feed.description = p; else (ev as unknown as Record<string, string>)[field] = p;
    const label = `${field}:${JSON.stringify(p.slice(0, 30))}`;
    let ics: string;
    try { ics = buildCalendar(feed, [ev, { ...base(), uid: "e2@feedcal.app", title: "Second" }], { defaultTimeZone: "America/Los_Angeles", reportUrl: (u) => `https://x.test/report/${encodeURIComponent(u)}`, product: "Calantern" }).ics; }
    catch (e) { add("build throws", label); continue; }
    if (new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]").test(ics)) add("raw control char in output", label);
    if (new RegExp("\\r(?!\\n)|(?<!\\r)\\n").test(ics)) add("bare CR or LF", label);
    if (new RegExp("[\\u2028\\u2029\\x85]").test(ics)) add("unicode line separator in output", label);
    for (const line of ics.split("\r\n")) if (new TextEncoder().encode(line).length > 75) { add("line over 75 octets", label); break; }
    let comp: ICAL.Component;
    try { comp = new ICAL.Component(ICAL.parse(ics)); } catch (e) { add("ical.js REJECTS the whole feed", label + " :: " + String(e).slice(0, 80)); continue; }
    const vevents = comp.getAllSubcomponents("vevent");
    if (vevents.length !== 2) add("wrong event count", `${label} -> ${vevents.length}`);
    if (comp.getAllSubcomponents("vcalendar").length) add("nested calendar", label);
    for (const v of vevents) for (const prop of v.getAllProperties()) if (!ALLOWED.has(prop.name.toUpperCase())) add("injected property", `${label} -> ${prop.name}`);
    for (const prop of comp.getAllProperties()) if (/inject|attendee/i.test(prop.name)) add("injected calendar property", `${label} -> ${prop.name}`);
    if (field === "title") { const got = vevents.find((v) => v.getFirstPropertyValue("uid") === "e1@feedcal.app")?.getFirstPropertyValue("summary"); if (typeof got === "string" && got.includes("pwn") === false && /X-INJECT/i.test(got) === false && got.length === 0) add("title lost", label); }
  }
  // Extreme dates and recurrence
  const timing: string[] = [];
  // A whole millennium of zone data used to take about a second; it must stay small.
  for (const [startsAt, endsAt] of [["0001-01-01T00:00:00Z", null], ["9999-12-31T00:00:00Z", null], ["1900-01-01T00:00:00Z", "2999-01-01T00:00:00Z"], ["2026-12-05T16:30:00Z", "2026-12-04T00:00:00Z"]] as const) {
    const t0 = performance.now();
    try { buildCalendar({ name: "x" }, [{ ...base(), startsAt, endsAt, rrule: "FREQ=WEEKLY;COUNT=5" }], { defaultTimeZone: "America/Los_Angeles" }); timing.push(`${startsAt}..${endsAt}: ${(performance.now() - t0).toFixed(0)} ms`); }
    catch (e) { timing.push(`${startsAt}..${endsAt}: THROWS ${String(e).slice(0, 60)}`); }
  }
  expect(n).toBeGreaterThan(400);
  expect(problems).toEqual({});
  for (const t of timing) expect(Number(/: (\d+) ms/.exec(t)?.[1] ?? 99999), t).toBeLessThan(150);
  for (const bad of ["FREQ=SECONDLY;COUNT=99999999", "FREQ=MINUTELY", "FREQ=HOURLY", "FREQ=DAILY;COUNT=5000", "FREQ=DAILY;BYHOUR=1", "FREQ=WEEKLY;COUNT=2;COUNT=3", "FREQ=DAILY\r\nX:1", "COUNT=2;FREQ=DAILY"]) {
    expect(buildCalendar({ name: "x" }, [{ ...base(), rrule: bad }], { defaultTimeZone: "America/Los_Angeles" }).ics).not.toContain("RRULE");
  }
  for (const good of ["FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261219", "FREQ=MONTHLY;BYMONTHDAY=1;COUNT=10", "FREQ=YEARLY", "FREQ=DAILY;INTERVAL=2;UNTIL=20261219T075959Z"]) {
    expect(buildCalendar({ name: "x" }, [{ ...base(), rrule: good }], { defaultTimeZone: "America/Los_Angeles" }).ics).toContain(`RRULE:${good}`);
  }
});
