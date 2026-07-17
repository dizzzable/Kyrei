/**
 * Provider-agnostic contracts for a bounded Team task graph.
 *
 * Artifacts are the only worker-to-worker hand-off. They deliberately contain
 * conclusions and verification metadata, not private model reasoning.
 */

export interface TeamTaskSpec {
  readonly id: string;
  readonly goal: string;
  readonly memberId?: string;
  readonly dependsOn?: readonly string[];
}

/**
 * Measurements attached to one Team task. Token fields remain optional because
 * some compatible providers do not return usage, while providerCalls is kept
 * separately so a caller can still enforce a conservative call budget.
 */
export interface TeamArtifactMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly toolCount?: number;
  readonly providerCalls?: number;
  readonly unmeteredProviderCalls?: number;
}

/** Aggregate, bounded measurements for a completed direct Team department. */
export interface TeamDepartmentMetrics extends TeamArtifactMetrics {
  readonly providerCalls: number;
  readonly unmeteredProviderCalls: number;
}

/**
 * Inspectable provenance for a page that a Team role actually fetched. The
 * page body stays out of cross-role artifacts; the digest lets a reviewer
 * distinguish this receipt from a model-written URL or search snippet.
 */
export interface TeamSourceReceipt {
  readonly id: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly contentDigest: string;
  readonly fetchedAt: string;
}

export interface TeamClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly impact?: string;
}

export interface TeamClarificationRequest {
  readonly id: string;
  readonly question: string;
  readonly context: string;
  readonly options?: readonly TeamClarificationOption[];
  readonly recommended?: string;
  readonly blocking: boolean;
}

export type TeamComparisonDecision = "converged" | "needs_verification" | "needs_human";

export interface TeamComparisonClaim {
  readonly id: string;
  readonly taskId: string;
  readonly summary: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly provenance: readonly string[];
}

export interface TeamComparisonConflict {
  readonly id: string;
  readonly claimIds: readonly string[];
  readonly summary: string;
  readonly resolved: false;
}

export interface TeamComparison {
  readonly version: 1;
  readonly decision: TeamComparisonDecision;
  readonly agreementScore: number;
  readonly claims: readonly TeamComparisonClaim[];
  readonly conflicts: readonly TeamComparisonConflict[];
  readonly clarificationRequests: readonly TeamClarificationRequest[];
}

export interface TeamArtifact {
  readonly taskId: string;
  readonly summary: string;
  readonly provenance: readonly string[];
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly validation: readonly string[];
  readonly uncertainties: readonly string[];
  readonly whatWasNotChecked: readonly string[];
  /** Questions that require the acting orchestrator or human, never a worker-to-worker chat. */
  readonly clarificationRequests?: readonly TeamClarificationRequest[];
  /**
   * Optional context-anchored patch for pipeline implementation stages.
   * Multi-line body must be preserved (never whitespace-collapsed). The
   * deterministic action executor applies it — team roles stay read-only.
   */
  readonly applicablePatch?: string;
  /** Successful direct web-fetches captured by runtime code, never model text. */
  readonly sources?: readonly TeamSourceReceipt[];
  readonly metrics?: TeamArtifactMetrics;
}

export interface TeamTaskExecutionContext {
  readonly task: TeamTaskSpec;
  readonly dependencyArtifacts: ReadonlyMap<string, TeamArtifact>;
  readonly signal: AbortSignal;
}

export type TeamTaskRunner = (
  context: TeamTaskExecutionContext,
) => TeamArtifact | Promise<TeamArtifact>;

export type TeamTaskStatus = "succeeded" | "failed" | "blocked" | "aborted";

export interface TeamTaskSucceededResult {
  readonly task: TeamTaskSpec;
  readonly status: "succeeded";
  readonly artifact: TeamArtifact;
}

export interface TeamTaskFailedResult {
  readonly task: TeamTaskSpec;
  readonly status: "failed";
  readonly error: unknown;
}

export interface TeamTaskBlockedResult {
  readonly task: TeamTaskSpec;
  readonly status: "blocked";
  readonly blockedBy: readonly string[];
}

export interface TeamTaskAbortedResult {
  readonly task: TeamTaskSpec;
  readonly status: "aborted";
  readonly reason?: unknown;
}

export type TeamTaskResult =
  | TeamTaskSucceededResult
  | TeamTaskFailedResult
  | TeamTaskBlockedResult
  | TeamTaskAbortedResult;

export interface ExecuteTeamTaskGraphOptions {
  /** One bound shared by every ready task in the graph. */
  readonly maxConcurrency: number;
  /** Cancellation stops queued tasks from starting; running tasks receive it. */
  readonly signal?: AbortSignal;
}
