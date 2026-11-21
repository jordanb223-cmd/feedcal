import { describe, expect, it } from "vitest";
import { handleEmail, NOT_READY_REASON } from "./handler.js";

describe("handleEmail (phase 1 stub)", () => {
  it("rejects with a plain-English reason and logs no addresses", () => {
    const logs: string[] = [];
    let reason = "";
    handleEmail({ from: "parent@example.com", to: "feed-abc@in.feedcal.app", rawSize: 1234, setReject: (r) => { reason = r; } }, (l) => logs.push(l));
    expect(reason).toBe(NOT_READY_REASON);
    expect(logs.join("")).not.toContain("example.com");
    expect(logs.join("")).not.toContain("feed-abc");
  });
});
