import { describe, expect, it } from "vitest";
import { createLogger, requestIdFrom } from "./logger.js";

describe("createLogger", () => {
  it("writes one JSON line with base and call fields", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "web" }, (l) => lines.push(l)).child({ request_id: "abc12345" });
    log.info("hello", { status: 200 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({ level: "info", msg: "hello", service: "web", request_id: "abc12345", status: 200 });
    expect(typeof entry.ts).toBe("string");
  });
});

describe("requestIdFrom", () => {
  it("keeps a well-formed id", () => {
    expect(requestIdFrom("req-12345678")).toBe("req-12345678");
  });
  it("replaces missing or malformed ids", () => {
    expect(requestIdFrom(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom("bad id with spaces")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom("x".repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
