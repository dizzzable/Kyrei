import {
  canonicalEvidenceDigest,
  validateArtifactEnvelope,
} from "./artifacts.js";
import type {
  ArtifactCheck,
  ArtifactEnvelope,
  EvidenceRef,
  TestEvidenceRef,
} from "./types.js";

export interface TruthGatePolicy {
  /** Digest of the workspace state being accepted now. */
  readonly workspaceDigest: string;
  /** Canonical digest of the exact applied action/change receipt under test. */
  readonly requiredActionDigest: string;
  readonly requiredChecks: readonly string[];
  /**
   * Trusted gateway/executor receipts keyed by evidence id. Each value is the
   * canonical SHA-256 of the complete immutable evidence object.
   */
  readonly observedEvidenceDigests: Readonly<Record<string, string>>;
  /** Exact expected test-definition digest for every required check id. */
  readonly testDigests: Readonly<Record<string, string>>;
}

export type TruthGateIssueCode =
  | "invalid_artifact"
  | "invalid_policy"
  | "missing_claim_evidence"
  | "reported_only_claim"
  | "stale_workspace_digest"
  | "missing_action_lineage"
  | "stale_test_digest"
  | "unresolved_contradiction"
  | "missing_required_check"
  | "required_check_not_passed"
  | "missing_check_evidence"
  | "reported_only_check"
  | "untrusted_observed_evidence"
  | "inconsistent_test_evidence";

export interface TruthGateIssue {
  readonly code: TruthGateIssueCode;
  readonly subjectId: string;
  readonly detail: string;
}

export interface TruthGateDecision {
  readonly accepted: boolean;
  readonly issues: readonly TruthGateIssue[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_POLICY_ITEMS = 2_000;
const MAX_POLICY_IDENTIFIER_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function policyValidationIssues(policy: unknown): readonly string[] {
  if (!isRecord(policy)) return ["policy must be an object"];
  const issues: string[] = [];
  if (!isDigest(policy.workspaceDigest)) {
    issues.push("workspaceDigest must be a SHA-256 digest");
  }
  if (!isDigest(policy.requiredActionDigest)) {
    issues.push("requiredActionDigest must be a SHA-256 digest");
  }
  if (
    !Array.isArray(policy.requiredChecks)
    || policy.requiredChecks.length > MAX_POLICY_ITEMS
    || !policy.requiredChecks.every((id) => (
      typeof id === "string" && id.trim().length > 0 && id.length <= MAX_POLICY_IDENTIFIER_LENGTH
    ))
  ) {
    issues.push("requiredChecks must be a bounded array of identifiers");
  }
  if (!isRecord(policy.observedEvidenceDigests)) {
    issues.push("observedEvidenceDigests must be an object");
  } else {
    const entries = Object.entries(policy.observedEvidenceDigests);
    if (
      entries.length > MAX_POLICY_ITEMS
      || entries.some(([id, digest]) => (
        id.trim().length === 0
        || id.length > MAX_POLICY_IDENTIFIER_LENGTH
        || !isDigest(digest)
      ))
    ) {
      issues.push("observedEvidenceDigests must map bounded identifiers to SHA-256 digests");
    }
  }
  if (!isRecord(policy.testDigests)) {
    issues.push("testDigests must be an object");
  } else {
    const entries = Object.entries(policy.testDigests);
    if (
      entries.length > MAX_POLICY_ITEMS
      || entries.some(([id, digest]) => (
        id.trim().length === 0
        || id.length > MAX_POLICY_IDENTIFIER_LENGTH
        || !isDigest(digest)
      ))
    ) {
      issues.push("testDigests must map bounded identifiers to SHA-256 digests");
    }
    if (Array.isArray(policy.requiredChecks)) {
      for (const checkId of policy.requiredChecks.slice(0, MAX_POLICY_ITEMS)) {
        if (
          typeof checkId === "string"
          && !isDigest(configuredDigest(policy.testDigests as Readonly<Record<string, string>>, checkId))
        ) {
          issues.push(`testDigests is missing an exact digest for required check ${checkId}`);
        }
      }
    }
  }
  return issues;
}

function trustedObservedEvidence(
  evidence: EvidenceRef,
  trustedDigests: Readonly<Record<string, string>>,
): boolean {
  if (evidence.origin !== "observed") return false;
  if (!Object.prototype.hasOwnProperty.call(trustedDigests, evidence.id)) return false;
  const expected = trustedDigests[evidence.id];
  if (!isDigest(expected)) return false;
  try {
    return canonicalEvidenceDigest(evidence) === expected.toLowerCase();
  } catch {
    return false;
  }
}

function configuredDigest(
  digests: Readonly<Record<string, string>>,
  id: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(digests, id)) {
    return undefined;
  }
  return digests[id];
}

function observedEvidence(
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, EvidenceRef>,
  trustedDigests: Readonly<Record<string, string>>,
): readonly EvidenceRef[] {
  return evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((evidence): evidence is EvidenceRef => (
      evidence !== undefined && trustedObservedEvidence(evidence, trustedDigests)
    ));
}

function testEvidenceFor(
  check: ArtifactCheck,
  evidence: readonly EvidenceRef[],
): readonly TestEvidenceRef[] {
  return evidence.filter(
    (item): item is TestEvidenceRef =>
      item.kind === "test" && item.checkId === check.id,
  );
}

/**
 * Deterministic completion gate. Both inputs are runtime boundaries: malformed
 * JSON is rejected as data and never allowed to escape as an exception.
 */
export function evaluateTruthGate(
  artifact: unknown,
  policy: unknown,
): TruthGateDecision {
  const issues: TruthGateIssue[] = [];
  const validation = validateArtifactEnvelope(artifact);
  const artifactSubject = isRecord(artifact) && typeof artifact.id === "string"
    ? artifact.id
    : "artifact";
  for (const issue of validation.issues) {
    issues.push({
      code: "invalid_artifact",
      subjectId: issue.id ?? artifactSubject,
      detail: `${issue.code}:${issue.field}${
        issue.referencedId ? `:${issue.referencedId}` : ""
      }`,
    });
  }

  const invalidPolicy = policyValidationIssues(policy);
  for (const detail of invalidPolicy) {
    issues.push({ code: "invalid_policy", subjectId: "policy", detail });
  }

  if (!validation.valid || invalidPolicy.length > 0) {
    return { accepted: false, issues };
  }

  const envelope = artifact as ArtifactEnvelope;
  const trustedPolicy = policy as TruthGatePolicy;
  const evidenceById = new Map(
    envelope.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const checkById = new Map(envelope.checks.map((check) => [check.id, check]));

  if (!envelope.inputDigests.includes(trustedPolicy.requiredActionDigest)) {
    issues.push({
      code: "missing_action_lineage",
      subjectId: envelope.id,
      detail: `verification does not reference applied action ${trustedPolicy.requiredActionDigest}`,
    });
  }

  if (envelope.workspaceDigest !== trustedPolicy.workspaceDigest) {
    issues.push({
      code: "stale_workspace_digest",
      subjectId: envelope.id,
      detail: `artifact=${envelope.workspaceDigest}; current=${trustedPolicy.workspaceDigest}`,
    });
  }

  for (const evidence of envelope.evidence) {
    if (
      evidence.origin === "observed"
      && !trustedObservedEvidence(evidence, trustedPolicy.observedEvidenceDigests)
    ) {
      issues.push({
        code: "untrusted_observed_evidence",
        subjectId: evidence.id,
        detail: "observed evidence does not match its trusted immutable receipt",
      });
    }
    if (
      evidence.workspaceDigest !== undefined
      && evidence.workspaceDigest !== trustedPolicy.workspaceDigest
    ) {
      issues.push({
        code: "stale_workspace_digest",
        subjectId: evidence.id,
        detail: `evidence=${evidence.workspaceDigest}; current=${trustedPolicy.workspaceDigest}`,
      });
    }
    if (evidence.kind === "test") {
      const expectedTestDigest = configuredDigest(trustedPolicy.testDigests, evidence.checkId);
      if (expectedTestDigest !== undefined && evidence.testDigest !== expectedTestDigest) {
        issues.push({
          code: "stale_test_digest",
          subjectId: evidence.id,
          detail: `evidence=${evidence.testDigest}; current=${expectedTestDigest}`,
        });
      }
    }
  }

  for (const claim of envelope.claims) {
    const referenced = claim.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((evidence): evidence is EvidenceRef => evidence !== undefined);
    if (referenced.length === 0) {
      issues.push({
        code: "missing_claim_evidence",
        subjectId: claim.id,
        detail: "claim has no resolvable evidence",
      });
    } else if (!referenced.some((evidence) => (
      trustedObservedEvidence(evidence, trustedPolicy.observedEvidenceDigests)
    ))) {
      issues.push({
        code: "reported_only_claim",
        subjectId: claim.id,
        detail: "claim has no evidence matching a trusted immutable receipt",
      });
    }
  }

  for (const contradiction of envelope.contradictions) {
    if (!contradiction.resolved) {
      issues.push({
        code: "unresolved_contradiction",
        subjectId: contradiction.id,
        detail: contradiction.summary,
      });
    }
  }

  for (const checkId of trustedPolicy.requiredChecks) {
    const check = checkById.get(checkId);
    if (!check) {
      issues.push({
        code: "missing_required_check",
        subjectId: checkId,
        detail: "required check is absent",
      });
      continue;
    }
    if (check.status !== "passed") {
      issues.push({
        code: "required_check_not_passed",
        subjectId: check.id,
        detail: `status=${check.status}`,
      });
    }
    if (check.workspaceDigest !== trustedPolicy.workspaceDigest) {
      issues.push({
        code: "stale_workspace_digest",
        subjectId: check.id,
        detail: `check=${check.workspaceDigest}; current=${trustedPolicy.workspaceDigest}`,
      });
    }

    const expectedTestDigest = configuredDigest(trustedPolicy.testDigests, check.id);
    if (check.testDigest !== expectedTestDigest) {
      issues.push({
        code: "stale_test_digest",
        subjectId: check.id,
        detail: `check=${check.testDigest ?? "missing"}; current=${expectedTestDigest}`,
      });
    }

    const observed = observedEvidence(
      check.evidenceIds,
      evidenceById,
      trustedPolicy.observedEvidenceDigests,
    );
    if (check.evidenceIds.length === 0) {
      issues.push({
        code: "missing_check_evidence",
        subjectId: check.id,
        detail: "required check has no evidence",
      });
    } else if (observed.length === 0) {
      issues.push({
        code: "reported_only_check",
        subjectId: check.id,
        detail: "required check has no evidence matching a trusted immutable receipt",
      });
    }

    const observedTests = testEvidenceFor(check, observed);
    if (observedTests.length === 0) {
      issues.push({
        code: "missing_check_evidence",
        subjectId: check.id,
        detail: "required test check has no matching observed test evidence",
      });
    }

    for (const evidence of observedTests) {
      if (check.status === "passed" && (!evidence.passed || evidence.exitCode !== 0)) {
        issues.push({
          code: "inconsistent_test_evidence",
          subjectId: check.id,
          detail: `check passed but evidence ${evidence.id} has passed=${evidence.passed}; exitCode=${evidence.exitCode}`,
        });
      }
      if (check.testDigest !== undefined && evidence.testDigest !== check.testDigest) {
        issues.push({
          code: "stale_test_digest",
          subjectId: evidence.id,
          detail: `evidence=${evidence.testDigest}; check=${check.testDigest}`,
        });
      }
    }
  }

  return { accepted: issues.length === 0, issues };
}
