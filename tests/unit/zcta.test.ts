import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { parseGazetteer } from "../../scripts/zcta.mjs";

describe("ZCTA gazetteer parser", () => {
  it("reads ZIP and internal point (lon lat order for PostGIS), skipping bad rows", () => {
    const text = "GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG                                                                                                               \n" +
      "99901\t1\t0\t0\t0\t38.550000\t-121.500000\n" +
      "ABCDE\t1\t0\t0\t0\t38\t-121\n" +
      "99902\t1\t0\t0\t0\t999\t-121\n";
    expect(parseGazetteer(text)).toEqual([{ zip: "99901", location: "SRID=4326;POINT(-121.5 38.55)" }]);
  });
  it("refuses a file that isn't the gazetteer", () => {
    expect(() => parseGazetteer("ZIP\tCITY\n95818\tSacramento\n")).toThrow(/Not a ZCTA gazetteer/);
  });
});
