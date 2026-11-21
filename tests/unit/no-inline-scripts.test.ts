// Phase 16 (D37): the CSP forbids inline scripts, so no page source may contain one.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web page sources", () => {
  it("no page source contains an inline script or an inline event handler", () => {
    const dir = new URL("../../apps/web/src/", import.meta.url);
    for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "assets.ts")) {
      const src = readFileSync(new URL(f, dir), "utf8");
      // Allowed: the JSON-LD data block (not executable) and the asset script tag.
      const scripts = [...src.matchAll(/<script(?![^>]*type="application\/ld\+json")(?![^>]*src=)[^>]*>/g)];
      expect(scripts.map((m) => `${f}: ${m[0]}`)).toEqual([]);
      expect([...src.matchAll(/\son[a-z]+="/g)].map((m) => `${f}: ${m[0]}`)).toEqual([]);
    }
  });
});
