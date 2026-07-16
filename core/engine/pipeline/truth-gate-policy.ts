/**
 * Trusted test runner + synthetic truth-gate artifact assembly.
 * Observed evidence is produced only by this gateway/engine path — never by LLM departments.
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ObserveWorkspaceFn } from "./action-executor.js";
import { canonicalEvidenceDigest } from "./artifacts.js";
import { evaluateTruthGate, type TruthGatePolicy } from "./truth-gate.js";
import type {
  ArtifactCheck,
  ArtifactEnvelope,
  TestEvidenceRef,
  TruthGateReceipt,
} from "./types.js";
import { sanitizeEnv } from "../security/secrets.js";
import { maybeSandbox, type Sandbox } from "../security/sandbox.js";
import { detectEcosystem } from "../reliability/verify.js";

export type RunTrustedCommandFn = (input: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<{ exitCode: number; output: string }>;

export interface TruthGateCheckPin {
  readonly id: string;
  readonly command: string;
  readonly ecosystem?: string;
  readonly testDigest: string;
}

export class PipelineTruthGateError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "PipelineTruthGateError";
    this.code = code;
    this.details = details;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Base command runner (spawn + sanitized env). Prefer createSandboxedTrustedCommandRunner in production. */
export function createDefaultTrustedCommandRunner(): RunTrustedCommandFn {
  return ({ command, cwd, signal, timeoutMs = 120_000 }) => new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: sanitizeEnv(process.env),
    });
    let output = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: 1, output: `spawn error: ${error.message}`.slice(0, 8_000) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code ?? 1, output: output.slice(0, 8_000) });
    });
  });
}

/**
 * Trusted test runner with optional OS sandbox wrap (same class of isolation as run_command).
 * On Windows / when primitive unavailable, maybeSandbox fails open to jail+env only.
 */
export function createSandboxedTrustedCommandRunner(
  sandbox: Sandbox,
  options: { allowNetwork?: boolean; required?: boolean } = {},
): RunTrustedCommandFn {
  const base = createDefaultTrustedCommandRunner();
  return async (input) => {
    const wrapped = await maybeSandbox(
      sandbox,
      {
        command: input.command,
        cwd: input.cwd,
        allowNetwork: options.allowNetwork === true,
      },
      { required: options.required === true },
    );
    return base({ ...input, command: wrapped.command });
  };
}

export function pinTestDigest(check: { command: string; ecosystem?: string }): string {
  return sha256(JSON.stringify({
    ecosystem: check.ecosystem || "custom",
    command: check.command,
    cwdPolicy: "workspace-root",
  }));
}

export async function listWorkspaceRootNames(workspace: string): Promise<string[]> {
  try {
    return await readdir(workspace);
  } catch {
    return [];
  }
}

export function resolveTruthGateChecks(
  stage: { metadata?: { checks?: unknown } },
  rootFiles: string[],
): TruthGateCheckPin[] {
  const raw = stage.metadata?.checks;
  if (Array.isArray(raw) && raw.length > 0) {
    const pins: TruthGateCheckPin[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.command !== "string") continue;
      const ecosystem = typeof record.ecosystem === "string" ? record.ecosystem : undefined;
      const testDigest = typeof record.testDigest === "string" && /^[a-f0-9]{64}$/i.test(record.testDigest)
        ? record.testDigest.toLowerCase()
        : pinTestDigest({ command: record.command, ecosystem });
      const expected = pinTestDigest({ command: record.command, ecosystem });
      if (expected !== testDigest) {
        throw new PipelineTruthGateError(
          "pipeline_truth_gate_test_definition_tampered",
          `check ${record.id} testDigest pin mismatch`,
        );
      }
      pins.push({
        id: record.id,
        command: record.command,
        ...(ecosystem ? { ecosystem } : {}),
        testDigest,
      });
    }
    if (pins.length) return pins;
  }
  // Fallback: freeze detectEcosystem suggestions for this workspace snapshot.
  return detectEcosystem(rootFiles).map((cmd) => ({
    id: cmd.ecosystem,
    command: cmd.command,
    ecosystem: cmd.ecosystem,
    testDigest: pinTestDigest({ command: cmd.command, ecosystem: cmd.ecosystem }),
  }));
}

export async function runTrustedChecks(input: {
  workspace: string;
  checks: readonly TruthGateCheckPin[];
  workspaceDigest: string;
  signal?: AbortSignal;
  runCommand: RunTrustedCommandFn;
  now?: () => string;
}): Promise<TestEvidenceRef[]> {
  const capturedAt = (input.now ?? (() => new Date().toISOString()))();
  const evidence: TestEvidenceRef[] = [];
  for (const check of input.checks) {
    throwIfAborted(input.signal);
    const result = await input.runCommand({
      command: check.command,
      cwd: input.workspace,
      signal: input.signal,
    });
    const passed = result.exitCode === 0;
    evidence.push({
      id: `trusted-test:${check.id}`,
      kind: "test",
      origin: "observed",
      summary: passed ? `Check ${check.id} passed` : `Check ${check.id} failed (exit ${result.exitCode})`,
      capturedAt,
      workspaceDigest: input.workspaceDigest,
      checkId: check.id,
      command: check.command,
      cwd: input.workspace,
      exitCode: result.exitCode,
      passed,
      testDigest: check.testDigest,
      outputDigest: sha256(result.output),
    });
  }
  return evidence;
}

export function buildTruthGateArtifact(input: {
  runId: string;
  stageId: string;
  workspaceDigest: string;
  actionReceiptDigests: readonly string[];
  trustedEvidence: readonly TestEvidenceRef[];
  checks: readonly TruthGateCheckPin[];
  runtimeFingerprint?: string;
  now?: () => string;
}): ArtifactEnvelope {
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const checks: ArtifactCheck[] = input.checks.map((check) => {
    const evidence = input.trustedEvidence.find((item) => item.checkId === check.id);
    const passed = evidence?.passed === true && evidence.exitCode === 0;
    return {
      id: check.id,
      status: passed ? "passed" : "failed",
      evidenceIds: evidence ? [evidence.id] : [],
      workspaceDigest: input.workspaceDigest,
      testDigest: check.testDigest,
    };
  });
  const evidenceIds = input.trustedEvidence.map((item) => item.id);
  return {
    schemaVersion: 1,
    id: `truth-gate:${input.runId}:${input.stageId}:${sha256(createdAt).slice(0, 16)}`,
    kind: "verification",
    runId: input.runId,
    stageId: input.stageId,
    producerId: "kyrei:trusted-test-runner",
    createdAt,
    summary: "Trusted verification (gateway-owned test runner).",
    workspaceDigest: input.workspaceDigest,
    inputDigests: [...input.actionReceiptDigests],
    assumptions: [],
    uncertainties: [],
    unchecked: [],
    provenance: {
      providerId: "kyrei",
      modelId: "none",
      policyDigest: input.runtimeFingerprint && /^[a-f0-9]{64}$/i.test(input.runtimeFingerprint)
        ? input.runtimeFingerprint.toLowerCase()
        : sha256("kyrei-trusted-test-runner-v1"),
    },
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerCalls: 0,
      durationMs: 0,
    },
    claims: evidenceIds.length
      ? [{
        id: "claim-tests",
        statement: "Required checks were executed by the trusted test runner.",
        evidenceIds,
      }]
      : [],
    evidence: [...input.trustedEvidence],
    checks,
    contradictions: [],
  };
}

export function assembleTruthGatePolicy(input: {
  workspaceDigest: string;
  actionReceiptDigests: readonly string[];
  requiredChecks: readonly string[];
  trustedEvidence: readonly TestEvidenceRef[];
  testDigests: Readonly<Record<string, string>>;
}): TruthGatePolicy {
  if (input.actionReceiptDigests.length !== 1) {
    throw new PipelineTruthGateError(
      "pipeline_truth_gate_action_lineage_invalid",
      `expected exactly one action receipt digest, got ${input.actionReceiptDigests.length}`,
    );
  }
  const observedEvidenceDigests = Object.fromEntries(
    input.trustedEvidence.map((evidence) => [evidence.id, canonicalEvidenceDigest(evidence)]),
  );
  return {
    workspaceDigest: input.workspaceDigest,
    requiredActionDigest: input.actionReceiptDigests[0]!,
    requiredChecks: [...input.requiredChecks],
    observedEvidenceDigests,
    testDigests: { ...input.testDigests },
  };
}

export interface VerifyPipelineTruthGateInput {
  readonly run: {
    readonly runId?: string;
    readonly id?: string;
    readonly workspace: string;
    readonly runtimeFingerprint?: string;
  };
  readonly stage: {
    readonly id: string;
    readonly metadata?: { checks?: unknown };
  };
  readonly dependencyArtifacts?: Record<string, unknown>;
  readonly actionReceiptDigests: readonly string[];
  readonly signal?: AbortSignal;
}

export interface VerifyPipelineTruthGateOptions {
  readonly observeWorkspace: ObserveWorkspaceFn;
  readonly runCommand?: RunTrustedCommandFn;
  readonly listRootFiles?: (workspace: string) => Promise<string[]>;
  readonly now?: () => string;
}

/**
 * Option (b): trusted runner inside truth-gate verifier.
 * Builds a synthetic verification envelope — never trusts department artifacts as-is.
 */
export async function verifyPipelineTruthGate(
  input: VerifyPipelineTruthGateInput,
  options: VerifyPipelineTruthGateOptions,
): Promise<{ truthGateReceipt: TruthGateReceipt; syntheticArtifact: ArtifactEnvelope }> {
  throwIfAborted(input.signal);
  const runId = input.run.runId ?? input.run.id;
  if (typeof runId !== "string" || !runId) {
    throw new PipelineTruthGateError("pipeline_truth_gate_run_invalid");
  }
  const digests = [...new Set(
    input.actionReceiptDigests
      .map((value) => String(value).toLowerCase())
      .filter((value) => /^[a-f0-9]{64}$/.test(value)),
  )].sort();
  if (digests.length !== 1) {
    throw new PipelineTruthGateError(
      "pipeline_truth_gate_action_lineage_invalid",
      `expected one action receipt digest, got ${digests.length}`,
    );
  }

  const observation = await options.observeWorkspace(input.run.workspace);
  const rootFiles = await (options.listRootFiles ?? listWorkspaceRootNames)(input.run.workspace);
  const checks = resolveTruthGateChecks(input.stage, rootFiles);
  if (!checks.length) {
    throw new PipelineTruthGateError("pipeline_truth_gate_checks_missing");
  }

  const runCommand = options.runCommand ?? createDefaultTrustedCommandRunner();
  const trustedEvidence = await runTrustedChecks({
    workspace: input.run.workspace,
    checks,
    workspaceDigest: observation.digest,
    signal: input.signal,
    runCommand,
    now: options.now,
  });

  const syntheticArtifact = buildTruthGateArtifact({
    runId,
    stageId: input.stage.id,
    workspaceDigest: observation.digest,
    actionReceiptDigests: digests,
    trustedEvidence,
    checks,
    runtimeFingerprint: input.run.runtimeFingerprint,
    now: options.now,
  });

  const policy = assembleTruthGatePolicy({
    workspaceDigest: observation.digest,
    actionReceiptDigests: digests,
    requiredChecks: checks.map((check) => check.id),
    trustedEvidence,
    testDigests: Object.fromEntries(checks.map((check) => [check.id, check.testDigest])),
  });

  const decision = evaluateTruthGate(syntheticArtifact, policy);
  if (!decision.accepted) {
    throw new PipelineTruthGateError(
      "pipeline_truth_gate_rejected",
      decision.issues.map((issue) => `${issue.code}:${issue.subjectId}`).join("; "),
      decision.issues,
    );
  }

  return {
    truthGateReceipt: {
      workspaceDigest: observation.digest,
      observedAt: observation.observedAt,
      actionReceiptDigests: digests,
    },
    syntheticArtifact,
  };
}
