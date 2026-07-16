import type { TurnStatus } from "../types.js";
import type { BridgeState } from "./state.js";

export function computeStatus(
  st: BridgeState,
  maxSteps?: number,
  guardStopped:
    | false
    | "max_steps"
    | "repeated_tool_call"
    | "budget_exceeded"
    | "heal_handoff" = false,
): TurnStatus {
  if (st.aborted) return "interrupted"; // Property 4: cancel != error
  if (st.errored) return "error";
  if (st.pendingApprovals > 0) return "awaiting_approval";
  if (guardStopped === "budget_exceeded") return "budget_exceeded";
  if (guardStopped === "heal_handoff") return "heal_handoff";
  if (guardStopped === "max_steps" || guardStopped === "repeated_tool_call") return "max_steps";
  if (guardStopped) return "max_steps";
  if (maxSteps && st.stepCount >= maxSteps && !st.finished) return "max_steps";
  return "complete";
}
