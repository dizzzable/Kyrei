/**
 * Wave D0/E — lightweight harness efficiency metrics for coding agents.
 * Logs structured one-liners; snapshot returned on chat result + /api/usage.
 */

export interface HarnessMetricsSnapshot {
  sessionId?: string;
  turns: number;
  toolPrunes: number;
  toolBytesRaw: number;
  toolBytesShown: number;
  goalSkims: number;
  workingStatePins: number;
  softOverflows: number;
  hardOverflows: number;
  stageBSummaries: number;
  longTaskPlanGates: number;
  goalVerifies: number;
  /** Wave E */
  intentRoute?: string;
  intentReason?: string;
  postEditVerifies: number;
  postEditFailures: number;
  symbolMapCacheHits: number;
  cacheBreakpoints: boolean;
  /** 0–1 when toolBytesRaw > 0 */
  wasteRatio?: number;
  updatedAt?: string;
}

export function createHarnessMetrics(seed: { sessionId?: string } = {}) {
  const snap: HarnessMetricsSnapshot = {
    ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
    turns: 0,
    toolPrunes: 0,
    toolBytesRaw: 0,
    toolBytesShown: 0,
    goalSkims: 0,
    workingStatePins: 0,
    softOverflows: 0,
    hardOverflows: 0,
    stageBSummaries: 0,
    longTaskPlanGates: 0,
    goalVerifies: 0,
    postEditVerifies: 0,
    postEditFailures: 0,
    symbolMapCacheHits: 0,
    cacheBreakpoints: false,
  };

  return {
    snapshot(): HarnessMetricsSnapshot {
      const waste = snap.toolBytesRaw > 0
        ? (1 - snap.toolBytesShown / snap.toolBytesRaw)
        : undefined;
      return {
        ...snap,
        ...(waste !== undefined ? { wasteRatio: Math.round(waste * 1000) / 1000 } : {}),
        updatedAt: new Date().toISOString(),
      };
    },
    recordTurn() {
      snap.turns += 1;
    },
    recordToolPrune(rawChars: number, shownChars: number) {
      snap.toolPrunes += 1;
      snap.toolBytesRaw += Math.max(0, rawChars);
      snap.toolBytesShown += Math.max(0, shownChars);
    },
    recordGoalSkim() {
      snap.goalSkims += 1;
    },
    recordWorkingStatePin() {
      snap.workingStatePins += 1;
    },
    recordOverflow(kind: "soft" | "hard") {
      if (kind === "hard") snap.hardOverflows += 1;
      else snap.softOverflows += 1;
    },
    recordStageBSummary() {
      snap.stageBSummaries += 1;
    },
    recordLongTaskPlanGate() {
      snap.longTaskPlanGates += 1;
    },
    recordGoalVerify() {
      snap.goalVerifies += 1;
    },
    recordIntent(route: string, reason: string) {
      snap.intentRoute = route;
      snap.intentReason = reason;
    },
    recordPostEditVerify(ok: boolean) {
      snap.postEditVerifies += 1;
      if (!ok) snap.postEditFailures += 1;
    },
    recordSymbolMapCacheHit() {
      snap.symbolMapCacheHits += 1;
    },
    recordCacheBreakpoints(enabled: boolean) {
      snap.cacheBreakpoints = enabled;
    },
    /** One-line structured log for operators (no secrets). */
    log(label = "turn"): void {
      const waste = snap.toolBytesRaw > 0
        ? (1 - snap.toolBytesShown / snap.toolBytesRaw)
        : 0;
      console.info(
        `[kyrei harness] ${label}`
        + ` session=${snap.sessionId ?? "-"}`
        + ` intent=${snap.intentRoute ?? "-"}`
        + ` turns=${snap.turns}`
        + ` prunes=${snap.toolPrunes}`
        + ` tool_bytes=${snap.toolBytesShown}/${snap.toolBytesRaw}`
        + ` waste≈${(waste * 100).toFixed(0)}%`
        + ` skims=${snap.goalSkims}`
        + ` pins=${snap.workingStatePins}`
        + ` soft=${snap.softOverflows} hard=${snap.hardOverflows}`
        + ` sumB=${snap.stageBSummaries}`
        + ` planGate=${snap.longTaskPlanGates}`
        + ` goalV=${snap.goalVerifies}`
        + ` postEdit=${snap.postEditVerifies}/${snap.postEditFailures}`
        + ` mapCache=${snap.symbolMapCacheHits}`
        + ` cacheBp=${snap.cacheBreakpoints ? "yes" : "no"}`,
      );
    },
  };
}

export type HarnessMetrics = ReturnType<typeof createHarnessMetrics>;
