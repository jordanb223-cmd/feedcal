import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { zctaSqlBatches } from "../../scripts/zcta-sql.mjs";

describe("ZIP code SQL batches", () => {
  it("builds upserts in batches", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ zip: `9581${i}`, location: `SRID=4326;POINT(-121.4${i} 38.5${i})` }));
    const b = zctaSqlBatches(rows, 2) as string[];
    expect(b).toHaveLength(3);
    expect(b[0]).toContain("('95810', extensions.st_geogfromtext('SRID=4326;POINT(-121.40 38.50)'))");
    expect(b[0]).toContain("on conflict (zip) do update set location = excluded.location;");
  });
  it("refuses anything that isn't a ZIP and a point (no SQL injection)", () => {
    expect(() => zctaSqlBatches([{ zip: "9581'; drop table x;--", location: "SRID=4326;POINT(1 2)" }])).toThrow();
    expect(() => zctaSqlBatches([{ zip: "95818", location: "SRID=4326;POINT(1 2)); drop table x;--" }])).toThrow();
  });
});
