/**
 * Runaway/budget limits (Phase 4). Requirements §9.6.
 */

export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
  maxSubagents?: number;
  maxSteps?: number;
}

export interface BudgetUsage {
  tokens?: number;
  costUsd?: number;
  subagents?: number;
  steps?: number;
}

export interface BudgetBreach {
  breached: boolean;
  reason?: string;
}

export function checkBudget(limits: BudgetLimits, usage: BudgetUsage): BudgetBreach {
  if (limits.maxTokens != null && (usage.tokens ?? 0) > limits.maxTokens)
    return { breached: true, reason: `token budget exceeded (${usage.tokens}/${limits.maxTokens})` };
  if (limits.maxCostUsd != null && (usage.costUsd ?? 0) > limits.maxCostUsd)
    return { breached: true, reason: `cost budget exceeded ($${usage.costUsd}/$${limits.maxCostUsd})` };
  if (limits.maxSubagents != null && (usage.subagents ?? 0) > limits.maxSubagents)
    return { breached: true, reason: `subagent limit exceeded (${usage.subagents}/${limits.maxSubagents})` };
  if (limits.maxSteps != null && (usage.steps ?? 0) > limits.maxSteps)
    return { breached: true, reason: `step limit exceeded (${usage.steps}/${limits.maxSteps})` };
  return { breached: false };
}
