/**
 * Deterministic workspace.apply executor for pipeline action stages.
 * No LLM. Fail-closed. Lease lifecycle is owned by the mission runner.
 */

import { createHash } from "node:crypto";
import { applyPatch } from "../apply/apply.js";
import { parsePatch } from "../apply/parse-patch.js";
import { createSnapshotStore } from "../apply/snapshot.js";
import type { ActionReceipt, ArtifactEnvelope, PatchEvidenceRef } from "./types.js";

export type WorkspaceObservation = {
  readonly digest: string;
  readonly observedAt: string;
};

export type ObserveWorkspaceFn = (workspace: string) => Promise<WorkspaceObservation>;

export class PipelineActionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PipelineActionError";
    this.code = code;
  }
}

export interface ExecuteWorkspaceApplyInput {
  readonly run: {
    readonly workspace: string;
    readonly workspaceCheckpointDigest?: string;
  };
  readonly stage: {
    readonly id: string;
    readonly workspaceDigestBefore?: string | null;
    readonly metadata?: { action?: string };
  };
  readonly dependencyArtifacts: Record<string, readonly ArtifactEnvelope[]>;
  readonly signal?: AbortSignal;
  /** Present for lease-aware callers; executor does not release/quarantine. */
  readonly lease?: unknown;
}

export interface ExecuteWorkspaceApplyOptions {
  readonly observeWorkspace: ObserveWorkspaceFn;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function collectPatchEvidence(
  dependencyArtifacts: Record<string, readonly ArtifactEnvelope[]>,
): PatchEvidenceRef[] {
  const found: PatchEvidenceRef[] = [];
  for (const artifacts of Object.values(dependencyArtifacts)) {
    for (const artifact of artifacts ?? []) {
      for (const evidence of artifact.evidence ?? []) {
        if (evidence.kind === "patch") found.push(evidence);
      }
    }
  }
  return found;
}

/**
 * Apply exactly one upstream patch evidence to the run workspace.
 * Returns an ActionReceipt for the runner/store WeakSet trust path.
 */
export async function executeWorkspaceApply(
  input: ExecuteWorkspaceApplyInput,
  options: ExecuteWorkspaceApplyOptions,
): Promise<{ actionReceipt: ActionReceipt }> {
  throwIfAborted(input.signal);

  const workspace = input.run.workspace;
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new PipelineActionError("pipeline_action_workspace_invalid");
  }

  const baselineExpected = input.stage.workspaceDigestBefore
    ?? input.run.workspaceCheckpointDigest;
  if (typeof baselineExpected !== "string" || !/^[a-f0-9]{64}$/i.test(baselineExpected)) {
    throw new PipelineActionError("pipeline_action_baseline_mismatch", "missing workspaceDigestBefore");
  }

  const before = await options.observeWorkspace(workspace);
  if (before.digest.toLowerCase() !== baselineExpected.toLowerCase()) {
    throw new PipelineActionError(
      "pipeline_action_baseline_mismatch",
      `expected=${baselineExpected}; actual=${before.digest}`,
    );
  }

  const patches = collectPatchEvidence(input.dependencyArtifacts);
  if (patches.length !== 1) {
    throw new PipelineActionError(
      "pipeline_action_payload_missing",
      `expected exactly one patch evidence, found ${patches.length}`,
    );
  }
  const patchEvidence = patches[0]!;
  const expectedDigest = sha256(patchEvidence.patch);
  if (expectedDigest !== patchEvidence.patchDigest.toLowerCase()) {
    throw new PipelineActionError("pipeline_action_payload_digest_mismatch");
  }
  if (
    patchEvidence.workspaceDigest
    && patchEvidence.workspaceDigest.toLowerCase() !== before.digest.toLowerCase()
  ) {
    throw new PipelineActionError(
      "pipeline_action_baseline_mismatch",
      "patch evidence workspaceDigest does not match baseline",
    );
  }

  throwIfAborted(input.signal);
  let parsed;
  try {
    parsed = parsePatch(patchEvidence.patch);
  } catch (error) {
    throw new PipelineActionError(
      "pipeline_action_payload_missing",
      error instanceof Error ? error.message : "parsePatch failed",
    );
  }
  if (!parsed.length) {
    throw new PipelineActionError("pipeline_action_payload_missing", "empty patch");
  }

  const snapshot = createSnapshotStore(workspace);
  const report = await applyPatch(workspace, parsed, snapshot, input.signal);

  throwIfAborted(input.signal);
  const after = await options.observeWorkspace(workspace);

  const actionReceipt: ActionReceipt = {
    workspaceDigest: after.digest,
    workspaceDigestBefore: before.digest,
    observedAt: after.observedAt,
    patchDigest: expectedDigest,
    // Normalize separators so receipts are stable across Windows/POSIX.
    appliedFiles: report.files.map((file) => file.rel.replaceAll("\\", "/")),
  };
  return { actionReceipt };
}
