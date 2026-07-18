import { isStepCount, type StopCondition, type ToolSet } from "ai";
import type { EngineConfig } from "../types.js";
import { detectLoop, toolSignature } from "../reliability/loop-detect.js";
import {
  isBudgetBreached,
  shouldHealHandoff,
  toolOutcomesFromSteps,
  usageFromSteps,
} from "../reliability/runtime.js";

export type GuardStopReason =
  | "max_steps"
  | "repeated_tool_call"
  | "budget_exceeded"
  | "heal_handoff";

/** End one no-progress pass after N identical consecutive tool calls. */
export function hasRepeatedToolCall(
  threshold = 3,
): StopCondition<ToolSet> {
  return ({ steps }) => {
    const signatures = steps.flatMap((step) => step.toolCalls.map((call) => (
      toolSignature(call.toolName, call.input)
    )));
    return detectLoop(signatures, threshold);
  };
}

/** Build bounded live-loop guardrails and report which one ended the pass. */
export function buildStopWhen(
  cfg: EngineConfig,
  onStop?: (reason: GuardStopReason) => void,
): Array<StopCondition<ToolSet>> {
  const loop = cfg.reliability?.toolLoop ?? {
    repeatedCallThreshold: 3,
    hardStopEnabled: true,
    healAfterFailures: 3,
  };
  const repeatedToolCall: StopCondition<ToolSet> = (options) => {
    if (loop.hardStopEnabled === false) return false;
    const stopped = hasRepeatedToolCall(loop.repeatedCallThreshold)(options);
    if (stopped) onStop?.("repeated_tool_call");
    return stopped;
  };
  const maxSteps = isStepCount(cfg.maxSteps);
  const stepLimit: StopCondition<ToolSet> = async (options) => {
    const stopped = await maxSteps(options);
    if (stopped) onStop?.("max_steps");
    return stopped;
  };
  const budgetLimit: StopCondition<ToolSet> = (options) => {
    // maxSteps is already enforced above; this catches token/cost/subagent caps.
    if (
      cfg.reliability?.maxTokens == null
      && cfg.reliability?.maxCostUsd == null
      && cfg.reliability?.maxSubagents == null
    ) {
      return false;
    }
    const usage = usageFromSteps(options.steps as ReadonlyArray<{ usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }>);
    const breach = isBudgetBreached(cfg, usage);
    if (breach.breached) onStop?.("budget_exceeded");
    return breach.breached;
  };
  const healHandoff: StopCondition<ToolSet> = (options) => {
    if (cfg.reliability?.healHandoff === false) return false;
    const outcomes = toolOutcomesFromSteps(
      options.steps as ReadonlyArray<{
        content?: ReadonlyArray<{ type?: string }>;
        toolResults?: readonly unknown[];
      }>,
    );
    if (!shouldHealHandoff(outcomes, loop.healAfterFailures)) return false;
    onStop?.("heal_handoff");
    return true;
  };
  return [repeatedToolCall, healHandoff, budgetLimit, stepLimit];
}
