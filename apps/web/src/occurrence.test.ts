// D69: a repeating event is listed at its next coming date.
import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./review.js";

describe("nextOccurrence", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  it("picks the soonest date that is still to come, whatever the order", () => {
    expect(nextOccurrence(["2026-12-08T00:00:00+00:00", "2026-11-17T00:00:00+00:00", "2026-12-01T00:00:00+00:00"], now)).toBe("2026-12-01T00:00:00.000Z");
  });
  it("is null when nothing is left, the list is empty, or a value can't be read", () => {
    expect(nextOccurrence(["2026-11-17T00:00:00Z"], now)).toBeNull();
    expect(nextOccurrence([], now)).toBeNull();
    expect(nextOccurrence(null, now)).toBeNull();
    expect(nextOccurrence(["not a date"], now)).toBeNull();
  });
});
