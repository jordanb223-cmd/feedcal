// OWASP A03 (D37): every third-party GitHub Action is pinned to a full commit SHA, so a moved
// tag can't change what runs in CI or in a deploy. Dependabot proposes the updates.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Actions", () => {
  it("every `uses:` is pinned to a 40-character commit SHA", () => {
    const dir = new URL("../../.github/workflows/", import.meta.url);
    const loose: string[] = [];
    for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".yml"))) {
      for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/uses:\s*([^\s#]+)/g)) {
        const ref = m[1] ?? "";
        if (ref.startsWith("./")) continue; // local actions
        if (!/@[0-9a-f]{40}$/.test(ref)) loose.push(`${f}: ${ref}`);
      }
    }
    expect(loose).toEqual([]);
  });
});
