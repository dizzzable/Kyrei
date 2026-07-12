/** Eval metrics aggregation + regression check (Requirements §13.2). */

import type { EvalMetrics } from "./harness.js";

export interface Aggregate {
  passRate: number;
  medSteps: number;
  medTokens: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function aggregate(metrics: EvalMetrics[]): Aggregate {
  const pass = metrics.filter((m) => m.editSuccess).length;
  return {
    passRate: metrics.length ? pass / metrics.length : 0,
    medSteps: median(metrics.map((m) => m.steps)),
    medTokens: median(metrics.map((m) => m.tokens)),
  };
}

export interface RegressionResult {
  regressed: boolean;
  reasons: string[];
}

/** Regress if pass rate drops, or steps/tokens grow > 20% vs baseline (Req 13.2). */
export function checkRegression(baseline: Aggregate, current: Aggregate): RegressionResult {
  const reasons: string[] = [];
  if (current.passRate < baseline.passRate) reasons.push(`passRate ${current.passRate} < ${baseline.passRate}`);
  if (baseline.medSteps > 0 && current.medSteps > baseline.medSteps * 1.2) reasons.push(`steps +>20%`);
  if (baseline.medTokens > 0 && current.medTokens > baseline.medTokens * 1.2) reasons.push(`tokens +>20%`);
  return { regressed: reasons.length > 0, reasons };
}
