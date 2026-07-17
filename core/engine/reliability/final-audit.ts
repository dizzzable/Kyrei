/**
 * Final audit before declaring a long-horizon run complete (Wave A4).
 * Pure helpers: the agent/runtime supplies command evidence + file presence.
 */

import { RUN_MARKERS, type PhaseVerifyRow } from "../orchestration/run-kit.js";

export interface FinalAuditInput {
  /** Acceptance criteria from ROADMAP / phases. */
  criteria: PhaseVerifyRow[];
  /** Mandatory commands that were re-run (name + exit code). */
  commands: Array<{ name: string; exitCode: number; evidence?: string }>;
  /** Deliverable paths that must exist (checked by caller tools). */
  deliverables: Array<{ path: string; present: boolean }>;
  /** Optional cleanliness findings (debug prints, TODOs from this change set). */
  cleanlinessIssues?: string[];
  /** Share of criteria that are subjective (trust-prior). */
  trustPriorRatio?: number;
}

export interface FinalAuditResult {
  clean: boolean;
  coverage: number;
  gaps: string[];
  transcriptBlock: string;
}

/**
 * Aggregate a final audit. Does not execute tools — only scores evidence.
 */
export function evaluateFinalAudit(input: FinalAuditInput): FinalAuditResult {
  const gaps: string[] = [];
  for (const row of input.criteria) {
    if (!row.pass) gaps.push(`criterion_failed:${row.criterion.slice(0, 80)}`);
  }
  for (const cmd of input.commands) {
    if (cmd.exitCode !== 0) gaps.push(`command_failed:${cmd.name}:exit=${cmd.exitCode}`);
  }
  for (const d of input.deliverables) {
    if (!d.present) gaps.push(`deliverable_missing:${d.path}`);
  }
  for (const issue of input.cleanlinessIssues ?? []) {
    if (issue.trim()) gaps.push(`cleanliness:${issue.trim().slice(0, 80)}`);
  }

  // not_observed ≠ absent: zero evidence must never claim complete.
  const evidenceCount =
    input.criteria.length + input.commands.length + input.deliverables.length;
  if (evidenceCount === 0) {
    gaps.push("no_evidence_provided: supply criteria, re-run commands, or deliverable checks");
  }

  const totalChecks =
    evidenceCount
    + (input.cleanlinessIssues?.length ? 1 : 0)
    + (evidenceCount === 0 ? 1 : 0);
  const failed = gaps.length;
  const coverage = totalChecks === 0
    ? 0
    : Math.max(0, Math.min(1, (totalChecks - failed) / totalChecks));

  const trust = typeof input.trustPriorRatio === "number"
    ? Math.max(0, Math.min(1, input.trustPriorRatio))
    : 0;
  const clean = gaps.length === 0 && evidenceCount > 0;

  const lines = [
    RUN_MARKERS.finalAudit,
    `coverage=${(coverage * 100).toFixed(0)}%`,
    `trust_prior=${(trust * 100).toFixed(0)}%`,
    `gaps=${gaps.length}`,
    ...gaps.map((g) => `- ${g}`),
    clean ? RUN_MARKERS.auditComplete : "KYREI_AUDIT_GAPS",
    ...(clean && trust > 0.3
      ? ["WARNING: >30% of criteria rely on trust-prior-verify — human eyeball recommended."]
      : []),
    ...(clean ? [RUN_MARKERS.runComplete] : []),
  ];

  return {
    clean,
    coverage,
    gaps,
    transcriptBlock: lines.join("\n"),
  };
}
