import type { TurnStatus } from "../types.js";
import type { BridgeState } from "./state.js";

export function computeStatus(st: BridgeState, maxSteps?: number): TurnStatus {
  if (st.aborted) return "interrupted"; // Property 4: cancel != error
  if (st.errored) return "error";
  if (maxSteps && st.stepCount >= maxSteps && !st.finished) return "max_steps";
  return "complete";
}
