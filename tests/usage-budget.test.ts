import { describe, expect, it } from "vitest";
import {
  budgetWindowStartMs,
  evaluateUsageBudget,
  normalizeUsageBudgetConfig,
  usageBudgetFromEngine,
  withUsageBudget,
} from "../core/usage-budget.js";

describe("usage-budget", () => {
  it("normalizes disabled defaults and drops invalid limits", () => {
    expect(normalizeUsageBudgetConfig({})).toEqual({
      enabled: false,
      window: "day",
      softCostUsd: null,
      hardCostUsd: null,
      softTokens: null,
      hardTokens: null,
    });
    expect(normalizeUsageBudgetConfig({
      enabled: true,
      window: "month",
      softCostUsd: -1,
      hardCostUsd: "12.5",
      softTokens: 1000.9,
      hardTokens: 0,
    })).toMatchObject({
      enabled: true,
      window: "month",
      softCostUsd: null,
      hardCostUsd: 12.5,
      softTokens: 1000,
      hardTokens: null,
    });
  });

  it("evaluates soft vs hard levels", () => {
    const soft = evaluateUsageBudget({
      enabled: true,
      window: "day",
      softTokens: 100,
      hardTokens: 200,
      softCostUsd: 1,
      hardCostUsd: 5,
    }, { totalTokens: 150, costUsd: 0.5, requestCount: 3 });
    expect(soft.level).toBe("soft");
    expect(soft.blocked).toBe(false);
    expect(soft.warnings).toContain("soft_tokens_reached");

    const hard = evaluateUsageBudget({
      enabled: true,
      window: "day",
      hardCostUsd: 1,
      softCostUsd: 0.5,
    }, { totalTokens: 10, costUsd: 1.2 });
    expect(hard.level).toBe("hard");
    expect(hard.blocked).toBe(true);
    expect(hard.hardReasons).toContain("hard_cost_exceeded");
  });

  it("does not block when disabled even if over hard limits", () => {
    const snap = evaluateUsageBudget({
      enabled: false,
      hardTokens: 1,
    }, { totalTokens: 999 });
    expect(snap.blocked).toBe(false);
    expect(snap.level).toBe("ok");
  });

  it("computes UTC day/month window starts", () => {
    const noon = Date.parse("2026-07-15T12:34:56.000Z");
    expect(budgetWindowStartMs("day", noon)).toBe(Date.parse("2026-07-15T00:00:00.000Z"));
    expect(budgetWindowStartMs("month", noon)).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
  });

  it("reads and merges engine.usageBudget", () => {
    expect(usageBudgetFromEngine({ usageBudget: { enabled: true, hardTokens: 50 } })).toMatchObject({
      enabled: true,
      hardTokens: 50,
    });
    const next = withUsageBudget({ maxSteps: 12 }, { enabled: true, window: "month", softCostUsd: 3 });
    expect(next).toMatchObject({
      maxSteps: 12,
      usageBudget: { enabled: true, window: "month", softCostUsd: 3 },
    });
  });
});
