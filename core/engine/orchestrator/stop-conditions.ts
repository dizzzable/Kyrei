import { isStepCount, type StopCondition, type ToolSet } from "ai";
import type { EngineConfig } from "../types.js";

/**
 * Phase 1: stop after maxSteps. Token-budget stop condition + hasToolCall
 * termination land in Phase 4.
 */
export function buildStopWhen(cfg: EngineConfig): StopCondition<ToolSet> {
  return isStepCount(cfg.maxSteps);
}
