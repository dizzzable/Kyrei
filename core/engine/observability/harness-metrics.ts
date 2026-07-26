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
  /**
   * Whether cache breakpoints were ATTACHED. Kept, but it is not a measurement:
   * it is a static packing flag, so it answers "did we ask for caching" and
   * never "did caching happen". The token counters below are the measurement.
   */
  cacheBreakpoints: boolean;
  /** Prompt tokens served from the provider's cache across the turn. */
  cacheReadTokens: number;
  /** Prompt tokens written INTO the provider's cache across the turn. */
  cacheWriteTokens: number;
  /** Prompt tokens that were neither read from nor written to the cache. */
  uncachedInputTokens: number;
  /**
   * Reads ÷ all prompt tokens, when any were seen.
   *
   * This is the number that distinguishes a working cache from one that is
   * rewritten every step — the failure a moving breakpoint produces when a turn
   * emits more content blocks than the provider's lookback window. Reads alone
   * cannot show it: they simply stay near zero while writes climb.
   */
  cacheHitRate?: number;
  /**
   * Patch application outcomes.
   *
   * Editing is the most failure-prone surface in the harness and was the one
   * thing this file did not measure: fifteen counters for turns, prunes and
   * verification, and nothing at all for whether an edit actually landed.
   * Every decision downstream — which patch grammar to use per provider, how
   * far to let fuzzy matching stretch, whether a failed hunk should be retried
   * or surfaced — is a guess until these exist.
   */
  patchApplies: number;
  patchFailures: number;
  /** Failures by `ApplyErrorCode`, e.g. `{ NOT_FOUND: 3, AMBIGUOUS: 1 }`. */
  patchFailureCodes: Record<string, number>;
  /**
   * How often each fuzzy-match level rescued a hunk, by level name. Level 0 is
   * an exact match; anything above it means the model's context lines did not
   * match the file byte-for-byte.
   */
  patchMatchLevels: Record<string, number>;
  /** 0–1 when patchApplies + patchFailures > 0. */
  patchFailureRate?: number;
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
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    patchApplies: 0,
    patchFailures: 0,
    patchFailureCodes: {},
    patchMatchLevels: {},
  };

  return {
    snapshot(): HarnessMetricsSnapshot {
      const waste = snap.toolBytesRaw > 0
        ? (1 - snap.toolBytesShown / snap.toolBytesRaw)
        : undefined;
      const patchAttempts = snap.patchApplies + snap.patchFailures;
      const promptTokens = snap.cacheReadTokens + snap.cacheWriteTokens + snap.uncachedInputTokens;
      return {
        ...snap,
        ...(promptTokens > 0
          ? { cacheHitRate: Math.round((snap.cacheReadTokens / promptTokens) * 1000) / 1000 }
          : {}),
        patchFailureCodes: { ...snap.patchFailureCodes },
        patchMatchLevels: { ...snap.patchMatchLevels },
        ...(waste !== undefined ? { wasteRatio: Math.round(waste * 1000) / 1000 } : {}),
        ...(patchAttempts > 0
          ? { patchFailureRate: Math.round((snap.patchFailures / patchAttempts) * 1000) / 1000 }
          : {}),
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
    /** One patch application that landed. `matchLevel` names the strategy that found the hunk. */
    recordPatchApply(matchLevel?: string) {
      snap.patchApplies += 1;
      if (matchLevel) snap.patchMatchLevels[matchLevel] = (snap.patchMatchLevels[matchLevel] ?? 0) + 1;
    },
    /** One patch application that did not land, keyed by `ApplyErrorCode`. */
    recordPatchFailure(code: string) {
      snap.patchFailures += 1;
      snap.patchFailureCodes[code] = (snap.patchFailureCodes[code] ?? 0) + 1;
    },
    /**
     * Record one request's prompt-token split. Called per model call, so a
     * multi-step turn accumulates — which is the level the 20-block lookback
     * failure shows up at.
     */
    recordPromptTokens({ input = 0, cacheRead = 0, cacheWrite = 0 }: { input?: number; cacheRead?: number; cacheWrite?: number }) {
      const read = Math.max(0, cacheRead);
      const written = Math.max(0, Math.min(Math.max(0, input - read), cacheWrite));
      snap.cacheReadTokens += read;
      snap.cacheWriteTokens += written;
      snap.uncachedInputTokens += Math.max(0, input - read - written);
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
