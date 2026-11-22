// D57: deploys refuse unreviewed migrations that delete data.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../../.github/scripts/migration-guard.sh");
function run(files: Record<string, string>, applied: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mg-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  const r = spawnSync("bash", [SCRIPT, dir, "production"], { input: applied.join("\n"), encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("migration guard (D57)", () => {
  it("passes ordinary changes and code that only deletes when it is later called", () => {
    const r = run({
      "20300101000000_add.sql": "alter table public.feeds add column x int;\nalter table public.feeds alter column x set default 1;\n-- this comment mentions drop table t\n",
      "20300101000100_fn.sql": "create function private.purge() returns void language sql as $$ delete from public.events where false $$;\ndrop function if exists private.old();\n",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("flagged as deleting data: 0");
  });
  it("refuses an unreviewed drop, truncate or do-block delete, naming file and environment", () => {
    for (const sql of ["drop table public.events;", "TRUNCATE public.feeds;", "alter table t drop column c;", "do $$ begin delete from public.events; end $$;",
      "alter table t alter column c type int;", "alter table t alter column c set data type text;", "drop extension pgmq cascade;", "drop materialized view v;", "drop sequence s;"]) {
      const r = run({ "20300101000200_bad.sql": sql });
      expect(r.code, sql).toBe(1);
      expect(r.out).toContain("WARNING: 20300101000200_bad.sql DELETES or rewrites data in the production database");
      expect(r.out).toContain("REFUSING to push to production");
    }
  });
  it("warns but allows a reviewed one, and skips migrations already applied", () => {
    const reviewed = run({ "20300101000300_ok.sql": "-- destructive: reviewed\ndrop table public.old_stuff;\n" });
    expect(reviewed.code).toBe(0);
    expect(reviewed.out).toContain("WARNING: 20300101000300_ok.sql DELETES");
    const applied = run({ "20300101000400_old.sql": "drop table public.x;" }, ["20300101000400"]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("not yet applied to production: 0");
  });
});
