/**
 * Live wiring helpers for Phase-4 reliability modules.
 * Pure utilities stay in sibling files; this module composes them for run.ts.
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { EngineConfig } from "../types.js";
import { cleanupIncomplete } from "./cleanup.js";
import { sanitizeModelMessages } from "./model-message-sanitize.js";
import { checkBudget, type BudgetLimits, type BudgetUsage } from "./budget.js";
import { verifyGoal, type GoalJudge, type GoalVerdict } from "./goal-verifier.js";
import {
  healAgentGuidance,
  healTranscriptMarker,
  type HealState,
} from "./self-heal.js";

/** Sanitize history so the next model request cannot see dangling tool pairs. */
export function prepareMessagesForModel(messages: readonly ModelMessage[]): ModelMessage[] {
  return cleanupIncomplete(sanitizeModelMessages(messages).messages);
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
 * Cheap text-only goal judge. Semantic negative verdicts remain fail-closed.
 * Provider, transport and parser failures are unavailable rather than unmet goals.
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
      if (!match) return { satisfied: false, unavailable: true };
      const parsed = JSON.parse(match[0]!) as { satisfied?: unknown; gap?: unknown };
      return {
        satisfied: parsed.satisfied === true,
        ...(typeof parsed.gap === "string" && parsed.gap.trim()
          ? { gap: parsed.gap.trim().slice(0, 500) }
          : {}),
      };
    } catch {
      return { satisfied: false, unavailable: true };
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
 * Wave A: states map to transcript markers (probe / escalate / handoff).
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
    /** KYREI_FAILURE_* marker for the current state. */
    get marker() {
      return healTranscriptMarker(state);
    },
    /** Short model guidance for the current heal stage. */
    get guidance() {
      return healAgentGuidance(state);
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
      // Wave A 3-strike ↔ markers: strike1 retry→ESCALATE, strike2 fix_retry→ESCALATE,
      // strike3 handoff→HANDOFF. Initial idle state is "probe" (KYREI_FAILURE_PROBE).
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
 * Extract one ordered tool outcome per AI SDK model step.
 * A parallel tool batch is one attempt, not one retry per call. Any successful
 * result in that batch counts as progress and resets the failure streak.
 * Soft string-returned denials remain successes (the model can still self-heal).
 */
export function toolOutcomesFromSteps(
  steps: ReadonlyArray<{
    content?: ReadonlyArray<{ type?: string }>;
    toolResults?: readonly unknown[];
  }>,
): boolean[] {
  const outcomes: boolean[] = [];
  for (const step of steps) {
    const content = Array.isArray(step.content) ? step.content : [];
    const hasResult = content.some((part) => part?.type === "tool-result")
      || (step.toolResults?.length ?? 0) > 0;
    const hasError = content.some((part) => part?.type === "tool-error");
    if (hasResult) outcomes.push(true);
    else if (hasError) outcomes.push(false);
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
