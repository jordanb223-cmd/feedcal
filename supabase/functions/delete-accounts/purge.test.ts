import { assertEquals } from "jsr:@std/assert@1";
import { isServiceRole, runPurge, type PurgeClient } from "./purge.ts";

function fakeClient(due: string[], failOn = new Set<string>()): PurgeClient & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    dueAccounts: () => Promise.resolve(due),
    purgeData: (id) => (failOn.has(id) ? Promise.reject(new Error("boom")) : Promise.resolve({ feeds_transferred: 1, feeds_deleted: 2 })),
    deleteAuthUser: (id) => {
      deleted.push(id);
      return Promise.resolve(true);
    },
  };
}

Deno.test("purges every due account and totals the feeds", async () => {
  const client = fakeClient(["a", "b"]);
  assertEquals(await runPurge(client), { due: 2, deleted: 2, failed: 0, feeds_transferred: 2, feeds_deleted: 4 });
  assertEquals(client.deleted, ["a", "b"]);
});

Deno.test("a failure skips that account's auth deletion and continues", async () => {
  const client = fakeClient(["a", "b", "c"], new Set(["b"]));
  const r = await runPurge(client);
  assertEquals(r.failed, 1);
  assertEquals(client.deleted, ["a", "c"]);
});

Deno.test("respects the per-run maximum", async () => {
  const client = fakeClient(["a", "b", "c"]);
  assertEquals((await runPurge(client, 2)).due, 2);
});

Deno.test("only the exact service-role key is accepted", () => {
  assertEquals(isServiceRole("Bearer secret-key", "secret-key"), true);
  assertEquals(isServiceRole("Bearer anon-key", "secret-key"), false);
  assertEquals(isServiceRole("secret-key", "secret-key"), false);
  assertEquals(isServiceRole(null, "secret-key"), false);
  assertEquals(isServiceRole("Bearer ", undefined), false);
});
