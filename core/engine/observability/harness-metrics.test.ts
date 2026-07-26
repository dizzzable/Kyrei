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

describe("prompt-cache accounting", () => {
  it("separates reads, writes and fresh tokens across a multi-step turn", () => {
    const m = createHarnessMetrics();
    // Step 1: cold — the whole prefix is written, nothing read.
    m.recordPromptTokens({ input: 10_000, cacheRead: 0, cacheWrite: 9_000 });
    // Step 2: warm — the prefix is read back, only the new tail is fresh.
    m.recordPromptTokens({ input: 10_500, cacheRead: 9_000, cacheWrite: 500 });

    const snap = m.snapshot();
    expect(snap.cacheReadTokens).toBe(9_000);
    expect(snap.cacheWriteTokens).toBe(9_500);
    expect(snap.uncachedInputTokens).toBe(2_000);
    expect(snap.cacheHitRate).toBeCloseTo(9_000 / 20_500, 3);
  });

  it("distinguishes a working cache from one rewritten every step", () => {
    // The failure a moving breakpoint produces when a turn emits more content
    // blocks than the provider's lookback window: writes climb, reads stay at
    // zero. Counting reads alone cannot tell this apart from "no caching yet".
    const rewritten = createHarnessMetrics();
    for (let step = 0; step < 5; step += 1) {
      rewritten.recordPromptTokens({ input: 10_000, cacheRead: 0, cacheWrite: 9_000 });
    }
    expect(rewritten.snapshot().cacheHitRate).toBe(0);
    expect(rewritten.snapshot().cacheWriteTokens).toBe(45_000);

    const healthy = createHarnessMetrics();
    healthy.recordPromptTokens({ input: 10_000, cacheRead: 0, cacheWrite: 9_000 });
    for (let step = 0; step < 4; step += 1) {
      healthy.recordPromptTokens({ input: 10_000, cacheRead: 9_000, cacheWrite: 0 });
    }
    expect(healthy.snapshot().cacheHitRate!).toBeGreaterThan(0.6);
  });

  it("reports no hit rate at all when the provider reports no prompt tokens", () => {
    // Absent is not the same as zero: a provider that does not report token
    // splits must not read as "the cache never hits".
    expect(createHarnessMetrics().snapshot().cacheHitRate).toBeUndefined();
  });

  it("never lets a nonsensical provider split produce negative counters", () => {
    const m = createHarnessMetrics();
    m.recordPromptTokens({ input: 100, cacheRead: 500, cacheWrite: 500 });
    const snap = m.snapshot();
    expect(snap.uncachedInputTokens).toBe(0);
    expect(snap.cacheWriteTokens).toBe(0);
  });
});
