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

export interface TeamArtifact {
  readonly taskId: string;
  readonly summary: string;
  readonly provenance: readonly string[];
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly validation: readonly string[];
  readonly uncertainties: readonly string[];
  readonly whatWasNotChecked: readonly string[];
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
