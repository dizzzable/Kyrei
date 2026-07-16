/**
 * Provider-agnostic contracts for durable, evidence-bearing pipeline runs.
 *
 * Departments exchange artifact envelopes rather than model transcripts. This
 * keeps orchestration state serializable and makes completion gates auditable.
 */

export type PipelineRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "budget_paused"
  | "awaiting_approval"
  | "blocked"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type PipelineStageStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "budget_paused"
  | "interrupted"
  | "uncertain"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type PipelineStageKind =
  | "department"
  | "approval"
  | "action"
  | "truth-gate";

export interface PipelineTransitionRecord<Status extends string> {
  readonly from: Status;
  readonly to: Status;
  readonly at: string;
  readonly reason?: string;
}

export interface PipelineRunState {
  readonly id: string;
  readonly status: PipelineRunStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly transitions: readonly PipelineTransitionRecord<PipelineRunStatus>[];
}

export interface PipelineStageState {
  readonly id: string;
  readonly runId: string;
  readonly kind: PipelineStageKind;
  readonly status: PipelineStageStatus;
  readonly attempt: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /**
   * A durable verifier, outside this pure state machine, has established what
   * happened to an interrupted write. Generic transitions must never bypass
   * this receipt while the stage is `uncertain`.
   */
  readonly uncertaintyResolution?: PipelineUncertaintyResolution;
  readonly transitions: readonly PipelineTransitionRecord<PipelineStageStatus>[];
}

export interface PipelineTransitionInput {
  /** Caller-supplied timestamp keeps the domain deterministic and replayable. */
  readonly at: string;
  readonly reason?: string;
}

export type PipelineUncertaintyResolutionOutcome = "retry" | "applied" | "abandoned";

/**
 * The domain stores a digest rather than the raw verifier marker so resolution
 * records remain safe to replicate in journals and artifacts.
 */
export interface PipelineUncertaintyResolution {
  readonly markerDigest: string;
  readonly verifiedBy: string;
  readonly outcome: PipelineUncertaintyResolutionOutcome;
}

export type EvidenceOrigin = "observed" | "reported";

export interface EvidenceRefBase {
  readonly id: string;
  readonly origin: EvidenceOrigin;
  readonly summary: string;
  readonly capturedAt: string;
  /** Workspace snapshot against which this evidence was produced. */
  readonly workspaceDigest?: string;
}

export interface FileEvidenceRef extends EvidenceRefBase {
  readonly kind: "file";
  readonly path: string;
  readonly contentDigest: string;
}

export interface CommandEvidenceRef extends EvidenceRefBase {
  readonly kind: "command";
  /** A redacted label, not necessarily the raw command line. */
  readonly commandLabel: string;
  readonly exitCode: number;
  readonly outputDigest: string;
}

export interface TestEvidenceRef extends EvidenceRefBase {
  readonly kind: "test";
  readonly checkId: string;
  /** Exact redacted command line executed by the trusted test runner. */
  readonly command: string;
  /** Canonical working directory used for the test process. */
  readonly cwd: string;
  readonly exitCode: number;
  readonly passed: boolean;
  /** Digest of the test definition/configuration that was executed. */
  readonly testDigest: string;
  readonly outputDigest: string;
  readonly workspaceDigest: string;
}

export interface DiagnosticEvidenceRef extends EvidenceRefBase {
  readonly kind: "diagnostic";
  readonly tool: string;
  readonly outputDigest: string;
}

export interface UrlEvidenceRef extends EvidenceRefBase {
  readonly kind: "url";
  readonly url: string;
  readonly contentDigest?: string;
}

export interface ArtifactEvidenceRef extends EvidenceRefBase {
  readonly kind: "artifact";
  readonly artifactId: string;
  readonly artifactDigest: string;
}

/**
 * Applicable code change proposed by an implementation department.
 * Carries raw patch text (bounded) so a deterministic action-executor can apply
 * it without an LLM. origin is typically "reported" until apply succeeds.
 */
export interface PatchEvidenceRef extends EvidenceRefBase {
  readonly kind: "patch";
  /** Context-anchored patch body (parse-patch.ts format). */
  readonly patch: string;
  /** SHA-256 hex of the exact patch string. */
  readonly patchDigest: string;
}

export type EvidenceRef =
  | FileEvidenceRef
  | CommandEvidenceRef
  | TestEvidenceRef
  | DiagnosticEvidenceRef
  | UrlEvidenceRef
  | ArtifactEvidenceRef
  | PatchEvidenceRef;

/** Deterministic receipt produced by workspace.apply (no LLM). */
export interface ActionReceipt {
  readonly workspaceDigest: string;
  readonly workspaceDigestBefore: string;
  readonly observedAt: string;
  readonly patchDigest: string;
  readonly appliedFiles: readonly string[];
}

/** Deterministic receipt produced by a truth-gate after trusted verification. */
export interface TruthGateReceipt {
  readonly workspaceDigest: string;
  readonly observedAt: string;
  /** Sorted unique SHA-256 digests of upstream action receipts. */
  readonly actionReceiptDigests: readonly string[];
}

export interface ArtifactClaim {
  readonly id: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
}

export type ArtifactCheckStatus = "passed" | "failed" | "not_run";

export interface ArtifactCheck {
  readonly id: string;
  readonly status: ArtifactCheckStatus;
  readonly evidenceIds: readonly string[];
  readonly workspaceDigest: string;
  /** Digest of the exact test/check definition that was run, when applicable. */
  readonly testDigest?: string;
}

export interface ArtifactContradiction {
  readonly id: string;
  readonly claimIds: readonly string[];
  readonly summary: string;
  readonly resolved: boolean;
  readonly resolution?: string;
}

export type ArtifactKind =
  | "department"
  | "action"
  | "verification"
  | "improvement"
  | "assistance";

export interface ArtifactProvenance {
  readonly providerId: string;
  readonly modelId: string;
  /** Digest of the exact capability/safety policy used by the producer. */
  readonly policyDigest: string;
}

export interface ArtifactMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly providerCalls: number;
  readonly durationMs: number;
}

export interface ArtifactEnvelope {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly runId: string;
  readonly stageId: string;
  readonly producerId: string;
  readonly createdAt: string;
  readonly summary: string;
  /** Snapshot the producer inspected; consumers compare it to current state. */
  readonly workspaceDigest: string;
  readonly inputDigests: readonly string[];
  readonly assumptions: readonly string[];
  readonly uncertainties: readonly string[];
  readonly unchecked: readonly string[];
  readonly provenance: ArtifactProvenance;
  readonly metrics: ArtifactMetrics;
  readonly claims: readonly ArtifactClaim[];
  readonly evidence: readonly EvidenceRef[];
  readonly checks: readonly ArtifactCheck[];
  readonly contradictions: readonly ArtifactContradiction[];
}
