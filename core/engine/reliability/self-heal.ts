/**
 * Self-heal FSM (Phase 4). Requirements §9.4.
 * PROBE → RETRY → FIX_RETRY → HANDOFF (human). Pure state machine.
 */

export type HealState = "probe" | "retry" | "fix_retry" | "handoff" | "done";
export type HealOutcome = "success" | "failure";

export function nextHealState(current: HealState, outcome: HealOutcome): HealState {
  if (outcome === "success") return "done";
  switch (current) {
    case "probe":
      return "retry";
    case "retry":
      return "fix_retry";
    case "fix_retry":
      return "handoff";
    default:
      return "handoff";
  }
}

export function isTerminal(state: HealState): boolean {
  return state === "done" || state === "handoff";
}
