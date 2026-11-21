import { describe, expect, it } from "vitest";
import { canTransition, nextStates, STATE_LABELS, STATE_MACHINES, stateLabel, type MachineName } from "./state-machines.js";

describe("state machines (generated from the database)", () => {
  it("knows every enforced machine", () => {
    expect(Object.keys(STATE_MACHINES).sort()).toEqual(["attachment_status", "event_status", "message_status", "report_status"]);
  });

  it("agrees with the database on a legal and an illegal move", () => {
    expect(canTransition("message_status", "parsed", "extracted")).toBe(true);
    expect(canTransition("message_status", "parsed", "received")).toBe(false);
    expect(canTransition("report_status", "dismissed", "resolved")).toBe(false);
    expect(canTransition("event_status", "confirmed", "confirmed")).toBe(true);
  });

  it("lists next states", () => {
    expect(nextStates("message_status", "parsed").sort()).toEqual(["extracted", "failed", "ignored", "needs_review"]);
    // Phase 8: the owner can have a file re-read, or rule it out.
    expect(nextStates("attachment_status", "transcribed").sort()).toEqual(["pending", "skipped"]);
    expect(nextStates("report_status", "resolved")).toEqual(["open"]);
  });

  it("every state that appears in a transition has a label", () => {
    for (const name of Object.keys(STATE_MACHINES) as MachineName[]) {
      for (const t of STATE_MACHINES[name].transitions) {
        for (const s of [t.from, t.to]) expect(stateLabel(name, s as never), `${name}.${s}`).not.toBe(s);
      }
      expect(Object.keys(STATE_LABELS[name]).length).toBeGreaterThan(0);
    }
  });
});
