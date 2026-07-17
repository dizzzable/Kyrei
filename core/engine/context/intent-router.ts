/**
 * Wave E1 — deterministic intent pre-router (short fix vs long feature).
 * Runs before the model; pure heuristics, no LLM call.
 */

import { isLongHorizonGoal, lastUserTextFromMessages, userAuthorizedBuild } from "./goal-skim.js";

export type IntentRoute = "short_fix" | "long_feature" | "research" | "polish" | "neutral";

export interface IntentDecision {
  route: IntentRoute;
  /** Suggest forcing plan tools when combined with auto mode. */
  forcePlan: boolean;
  /** Prefer verifying the turn goal when claiming done. */
  preferGoalVerify: boolean;
  reason: string;
}

/**
 * Classify the user's latest goal for routing. Provider-agnostic.
 */
export function classifyIntent(text: string): IntentDecision {
  const t = String(text ?? "").trim();
  if (!t) {
    return { route: "neutral", forcePlan: false, preferGoalVerify: false, reason: "empty" };
  }
  if (userAuthorizedBuild(t)) {
    return { route: "long_feature", forcePlan: false, preferGoalVerify: true, reason: "user_authorized_build" };
  }
  if (/\b(audit|harden|bug.?hunt|polish|refactor for quality|проверь|аудит|баг|исправь баг)\b/i.test(t)
    && !isLongHorizonGoal(t)) {
    return { route: "polish", forcePlan: false, preferGoalVerify: true, reason: "polish_cues" };
  }
  if (/\b(research|investigate|compare|deep.?dive|исследуй|сравни|найди почему)\b/i.test(t)
    && t.length >= 40) {
    return { route: "research", forcePlan: false, preferGoalVerify: false, reason: "research_cues" };
  }
  if (isLongHorizonGoal(t)) {
    return { route: "long_feature", forcePlan: true, preferGoalVerify: true, reason: "long_horizon" };
  }
  // Short, concrete edit
  if (t.length < 160 || /\b(typo|rename|fix|one line|quick|просто|опечатк|переименуй)\b/i.test(t)) {
    return { route: "short_fix", forcePlan: false, preferGoalVerify: false, reason: "short_fix" };
  }
  return { route: "neutral", forcePlan: false, preferGoalVerify: false, reason: "default" };
}

export function classifyIntentFromMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  goal?: string,
): IntentDecision {
  const text = (goal ?? lastUserTextFromMessages(messages)).trim();
  return classifyIntent(text);
}
