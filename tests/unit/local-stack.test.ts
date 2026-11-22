// D57: the integration tests refuse any database that isn't on this computer.
import { describe, expect, it } from "vitest";
import { assertLocalStack, isLocalUrl } from "../integration/local-stack.js";

describe("local-only test guard (D57)", () => {
  it("accepts the local stack", () => {
    expect(isLocalUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLocalUrl("postgresql://postgres:postgres@localhost:54322/postgres")).toBe(true);
    expect(() => assertLocalStack({ API_URL: "http://127.0.0.1:54321", DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })).not.toThrow();
  });
  it("refuses a hosted project, naming the host but never the password", () => {
    expect(isLocalUrl("https://abc.supabase.co")).toBe(false);
    expect(() => assertLocalStack({ API_URL: "https://abc.supabase.co" })).toThrow(/REFUSING TO RUN: API_URL points at abc\.supabase\.co/);
    const db = "postgresql://postgres:hunter2@db.abc.supabase.co:5432/postgres";
    let message = "";
    try { assertLocalStack({ API_URL: "http://127.0.0.1:54321", DB_URL: db }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("db.abc.supabase.co");
    expect(message).not.toContain("hunter2");
  });
  it("refuses when the stack isn't running or the address is unreadable", () => {
    expect(() => assertLocalStack({})).toThrow(/isn't running/);
    expect(() => assertLocalStack({ API_URL: "not a url" })).toThrow(/REFUSING/);
  });
});
