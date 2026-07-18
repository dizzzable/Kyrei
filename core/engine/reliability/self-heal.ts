/**
 * Self-heal FSM (Phase 4). Requirements §9.4.
 * PROBE → RETRY → FIX_RETRY → HANDOFF (fresh automatic recovery pass).
 * `handoff` is terminal only for the current bounded model window, never for
 * the user's logical task.
 *
 * Wave A: map to Supergoal-shaped transcript markers (3-strike):
 *   probe → KYREI_FAILURE_PROBE (strike 1)
 *   retry / fix_retry → KYREI_FAILURE_ESCALATE (strike 2)
 *   handoff → KYREI_FAILURE_HANDOFF (strike 3)
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

/** 1-based strike index for the current heal state (1–3, or 0 if done). */
export function healStrike(state: HealState): 0 | 1 | 2 | 3 {
  switch (state) {
    case "probe":
      return 1;
    case "retry":
      return 2;
    case "fix_retry":
      return 2;
    case "handoff":
      return 3;
    default:
      return 0;
  }
}

/** Stable transcript marker for the current heal stage. */
export function healTranscriptMarker(state: HealState): string {
  switch (state) {
    case "probe":
      return "KYREI_FAILURE_PROBE";
    case "retry":
    case "fix_retry":
      return "KYREI_FAILURE_ESCALATE";
    case "handoff":
      return "KYREI_FAILURE_HANDOFF";
    case "done":
      return "KYREI_HEAL_DONE";
  }
}

/** Short instruction for the model when a heal transition fires. */
export function healAgentGuidance(state: HealState): string {
  switch (state) {
    case "probe":
      return "Print KYREI_FAILURE_PROBE with diagnosis; adjust args/path and retry once — do not repeat the identical call.";
    case "retry":
      return "Second failure: write a focused fix note (phase-N.fix.md if using a run kit), then execute a different approach.";
    case "fix_retry":
      return "Print KYREI_FAILURE_ESCALATE; apply the fix-spec approach. One more failure → handoff.";
    case "handoff":
      return "Print KYREI_FAILURE_HANDOFF with blockers and probe history; stop the identical strategy. The engine opens a fresh recovery pass that continues the original goal.";
    case "done":
      return "Recovery succeeded; continue the original goal.";
  }
}
