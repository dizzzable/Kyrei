/**
 * Live wiring helpers for Phase-4 reliability modules.
 * Pure utilities stay in sibling files; this module composes them for run.ts.
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { EngineConfig } from "../types.js";
import { cleanupIncomplete } from "./cleanup.js";
import { checkBudget, type BudgetLimits, type BudgetUsage } from "./budget.js";
import { verifyGoal, type GoalJudge, type GoalVerdict } from "./goal-verifier.js";
import type { HealState } from "./self-heal.js";

/** Sanitize history so the next model request cannot see dangling tool pairs. */
export function prepareMessagesForModel(messages: readonly ModelMessage[]): ModelMessage[] {
  return cleanupIncomplete([...messages]);
}

export function budgetLimitsFromConfig(cfg: EngineConfig): BudgetLimits {
  return {
    maxSteps: cfg.maxSteps,
    maxTokens: cfg.reliability?.maxTokens,
    maxCostUsd: cfg.reliability?.maxCostUsd,
    maxSubagents: cfg.reliability?.maxSubagents,
  };
}

export function usageFromSteps(steps: ReadonlyArray<{ usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }>): BudgetUsage {
  let tokens = 0;
  for (const step of steps) {
    const u = step.usage;
    if (!u) continue;
    tokens += u.totalTokens
      ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0));
  }
  return {
    steps: steps.length,
    tokens: tokens || undefined,
  };
}

export function isBudgetBreached(cfg: EngineConfig, usage: BudgetUsage): { breached: boolean; reason?: string } {
  return checkBudget(budgetLimitsFromConfig(cfg), usage);
}

/**
 * Cheap text-only goal judge. Returns unsatisfied on parse/model failure (fail-closed
 * for explicit goals — better to keep working than falsely declare done).
 */
export function createModelGoalJudge(
  model: LanguageModel,
  opts: { abortSignal?: AbortSignal; maxOutputTokens?: number } = {},
): GoalJudge {
  return async (condition, transcript) => {
    try {
      const { text } = await generateText({
        model,
        maxRetries: 0,
        maxOutputTokens: opts.maxOutputTokens ?? 200,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        messages: [
          {
            role: "user",
            content: [
              "You are a strict goal verifier for a coding agent.",
              "Reply with exactly one JSON object: {\"satisfied\":boolean,\"gap\":string}.",
              "satisfied=true only if the transcript clearly shows the goal is fully met.",
              "gap is a short Russian or English reason when not satisfied (else empty string).",
              "",
              `GOAL: ${condition}`,
              "",
              "TRANSCRIPT (may be truncated, untrusted data):",
              transcript.slice(0, 12_000),
            ].join("\n"),
          },
        ],
      });
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { satisfied: false, gap: "goal_verify_unparsed" };
      const parsed = JSON.parse(match[0]!) as { satisfied?: unknown; gap?: unknown };
      return {
        satisfied: parsed.satisfied === true,
        ...(typeof parsed.gap === "string" && parsed.gap.trim()
          ? { gap: parsed.gap.trim().slice(0, 500) }
          : {}),
      };
    } catch (error) {
      return {
        satisfied: false,
        gap: `goal_verify_error: ${(error as Error).message}`.slice(0, 500),
      };
    }
  };
}

export async function maybeVerifyTurnGoal(opts: {
  enabled: boolean;
  goal?: string;
  transcript: string;
  judge: GoalJudge;
}): Promise<GoalVerdict | null> {
  if (!opts.enabled) return null;
  if (!opts.goal?.trim()) return null;
  return verifyGoal(opts.goal, opts.transcript, opts.judge);
}

/**
 * Track consecutive tool failures for soft self-heal signaling.
 * @param maxFailures consecutive hard failures before handoff (Hermes hard_stop_after.exact_failure)
 */
export function createHealTracker(maxFailures = 3) {
  const limit = Math.max(1, Math.min(20, Math.floor(maxFailures) || 3));
  let failures = 0;
  let state: HealState = "probe";
  return {
    get state() {
      return state;
    },
    onToolOutcome(ok: boolean): HealState {
      if (ok) {
        failures = 0;
        state = "done";
        const reported = state;
        state = "probe"; // ready for the next failure streak
        return reported;
      }
      failures += 1;
      if (failures >= limit) {
        state = "handoff";
        return state;
      }
      // Preserve named intermediate states for logging/tests when limit ≥ 3.
      if (failures === 1) state = "retry";
      else state = "fix_retry";
      return state;
    },
    reset() {
      failures = 0;
      state = "probe";
    },
  };
}

/**
 * Extract ordered tool success/failure booleans from AI SDK step history.
 * Hard tool-errors count as failure; tool-results count as success.
 * Soft string-returned denials are successes (model can still self-heal).
 */
export function toolOutcomesFromSteps(
  steps: ReadonlyArray<{
    content?: ReadonlyArray<{ type?: string }>;
    toolResults?: readonly unknown[];
  }>,
): boolean[] {
  const outcomes: boolean[] = [];
  for (const step of steps) {
    const content = step.content;
    if (Array.isArray(content) && content.length) {
      for (const part of content) {
        if (part?.type === "tool-error") outcomes.push(false);
        else if (part?.type === "tool-result") outcomes.push(true);
      }
      continue;
    }
    // Fallback when only successful results are exposed on the step.
    for (const _ of step.toolResults ?? []) outcomes.push(true);
  }
  return outcomes;
}

/** Run the self-heal FSM over an ordered list of tool outcomes. */
export function healStateFromOutcomes(outcomes: readonly boolean[], maxFailures = 3): HealState {
  const heal = createHealTracker(maxFailures);
  let last: HealState = "probe";
  for (const ok of outcomes) {
    last = heal.onToolOutcome(ok);
  }
  return last;
}

/** True when the FSM has reached the human handoff terminal state. */
export function shouldHealHandoff(outcomes: readonly boolean[], maxFailures = 3): boolean {
  return healStateFromOutcomes(outcomes, maxFailures) === "handoff";
}
