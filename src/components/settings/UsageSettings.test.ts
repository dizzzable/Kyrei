import { describe, expect, it } from "vitest";

import { withReliabilityPolicy, withUsageBudget } from "./UsageSettings";

describe("UsageSettings engine updates", () => {
  const currentEngine = {
    memory: { index: { enabled: true } },
    permissions: { rules: [{ id: "keep-me" }] },
    reliability: { preserve: "value" },
  };

  it("preserves the latest parent engine draft when saving a usage budget", () => {
    expect(withUsageBudget(currentEngine, {
      enabled: true,
      window: "month",
      softCostUsd: 5,
      hardCostUsd: 10,
      softTokens: 1000,
      hardTokens: 2000,
    })).toEqual({
      ...currentEngine,
      usageBudget: {
        enabled: true,
        window: "month",
        softCostUsd: 5,
        hardCostUsd: 10,
        softTokens: 1000,
        hardTokens: 2000,
      },
    });
  });

  it("updates reliability without discarding unrelated engine or reliability fields", () => {
    expect(withReliabilityPolicy(currentEngine, {
      longTaskPlanGate: false,
      postEditVerify: "polish",
      verifyBeforeDone: false,
    })).toEqual({
      ...currentEngine,
      reliability: {
        preserve: "value",
        longTaskPlanGate: false,
        postEditVerify: "polish",
        verifyBeforeDone: false,
      },
    });
  });
});
