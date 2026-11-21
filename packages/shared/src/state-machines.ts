// Helpers over the generated state machines (the database is the source of truth; see
// docs/STATE-MACHINES.md). Labels are hand-written for people; the type below makes a new state
// without a label a compile error.
import { STATE_MACHINES } from "./state-machines.generated.js";

export { STATE_MACHINES };
export type MachineName = keyof typeof STATE_MACHINES;
type Transition<M extends MachineName> = (typeof STATE_MACHINES)[M]["transitions"][number];
export type StateOf<M extends MachineName> = Transition<M>["from"] | Transition<M>["to"];

/** Plain-English labels shown to organizers (review screens, badges). */
export const STATE_LABELS: { [M in MachineName]: Record<StateOf<M>, string> } = {
  event_status: { tentative: "Tentative", confirmed: "Confirmed", cancelled: "Cancelled" },
  message_status: {
    received: "Received",
    parsed: "Read",
    extracted: "Events found",
    needs_review: "Needs your review",
    ignored: "Ignored",
    failed: "Couldn't be read",
  },
  attachment_status: {
    pending: "Waiting",
    text_layer: "Text read",
    transcribed: "Read from image",
    skipped: "Skipped",
    failed: "Couldn't be read",
  },
  report_status: { open: "Open", resolved: "Fixed", dismissed: "Dismissed" },
};

export function canTransition<M extends MachineName>(machine: M, from: StateOf<M>, to: StateOf<M>): boolean {
  if (from === to) return true; // no change is always allowed
  return (STATE_MACHINES[machine].transitions as readonly { from: string; to: string }[]).some((t) => t.from === from && t.to === to);
}

export function nextStates<M extends MachineName>(machine: M, from: StateOf<M>): StateOf<M>[] {
  return (STATE_MACHINES[machine].transitions as readonly { from: string; to: string }[])
    .filter((t) => t.from === from)
    .map((t) => t.to as StateOf<M>);
}

export function stateLabel<M extends MachineName>(machine: M, state: StateOf<M>): string {
  return (STATE_LABELS[machine] as Record<string, string>)[state] ?? state;
}
