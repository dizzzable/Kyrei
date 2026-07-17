import { describe, expect, it } from "vitest";
import { createHarnessMetrics } from "./harness-metrics.js";

describe("harness metrics", () => {
  it("accumulates prune and skim counters", () => {
    const m = createHarnessMetrics({ sessionId: "s1" });
    m.recordTurn();
    m.recordToolPrune(10_000, 2_000);
    m.recordGoalSkim();
    m.recordWorkingStatePin();
    m.recordLongTaskPlanGate();
    m.recordIntent("long_feature", "long_horizon");
    m.recordPostEditVerify(false);
    m.recordSymbolMapCacheHit();
    m.recordCacheBreakpoints(true);
    const snap = m.snapshot();
    expect(snap.sessionId).toBe("s1");
    expect(snap.turns).toBe(1);
    expect(snap.toolPrunes).toBe(1);
    expect(snap.toolBytesRaw).toBe(10_000);
    expect(snap.toolBytesShown).toBe(2_000);
    expect(snap.goalSkims).toBe(1);
    expect(snap.workingStatePins).toBe(1);
    expect(snap.longTaskPlanGates).toBe(1);
    expect(snap.intentRoute).toBe("long_feature");
    expect(snap.postEditVerifies).toBe(1);
    expect(snap.postEditFailures).toBe(1);
    expect(snap.symbolMapCacheHits).toBe(1);
    expect(snap.cacheBreakpoints).toBe(true);
    expect(snap.wasteRatio).toBeCloseTo(0.8);
  });
});
