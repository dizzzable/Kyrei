import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalEvidenceDigest } from "./artifacts.js";
import { evaluateTruthGate } from "./truth-gate.js";
import type { ArtifactEnvelope, TruthGatePolicy } from "./index.js";

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const WORKSPACE_DIGEST = digest("workspace-current");
const OLD_WORKSPACE_DIGEST = digest("workspace-old");
const TEST_DEFINITION_DIGEST = digest("test-definition-current");
const OLD_TEST_DEFINITION_DIGEST = digest("test-definition-old");
const TEST_OUTPUT_DIGEST = digest("test-output-1");
const ACTION_DIGEST = digest("applied-action");

const BASE_POLICY = {
  workspaceDigest: WORKSPACE_DIGEST,
  requiredActionDigest: ACTION_DIGEST,
  requiredChecks: ["test"],
  testDigests: { test: TEST_DEFINITION_DIGEST },
} as const;

function verifiedArtifact(): ArtifactEnvelope {
  return {
    schemaVersion: 1,
    id: "artifact-verify",
    kind: "verification",
    runId: "run-1",
    stageId: "verify-1",
    producerId: "test-team",
    createdAt: "2026-07-13T10:00:00.000Z",
    summary: "Verification completed.",
    workspaceDigest: WORKSPACE_DIGEST,
    inputDigests: [ACTION_DIGEST],
    assumptions: [],
    uncertainties: [],
    unchecked: [],
    provenance: {
      providerId: "test-provider",
      modelId: "test-model",
      policyDigest: digest("verification-policy"),
    },
    metrics: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      providerCalls: 1,
      durationMs: 250,
    },
    claims: [
      {
        id: "claim-tests",
        statement: "Tests pass.",
        evidenceIds: ["evidence-test"],
      },
    ],
    evidence: [
      {
        id: "evidence-test",
        kind: "test",
        origin: "observed",
        summary: "Target suite passed.",
        capturedAt: "2026-07-13T10:00:00.000Z",
        workspaceDigest: WORKSPACE_DIGEST,
        checkId: "test",
        command: "npm test -- --run",
        cwd: "/workspace",
        exitCode: 0,
        passed: true,
        testDigest: TEST_DEFINITION_DIGEST,
        outputDigest: TEST_OUTPUT_DIGEST,
      },
    ],
    checks: [
      {
        id: "test",
        status: "passed",
        evidenceIds: ["evidence-test"],
        workspaceDigest: WORKSPACE_DIGEST,
        testDigest: TEST_DEFINITION_DIGEST,
      },
    ],
    contradictions: [],
  };
}

function policyFor(artifact: ArtifactEnvelope = verifiedArtifact()): TruthGatePolicy {
  const observedEvidenceDigests = Object.fromEntries(
    artifact.evidence
      .filter((evidence) => evidence.origin === "observed")
      .map((evidence) => [evidence.id, canonicalEvidenceDigest(evidence)]),
  );
  return { ...BASE_POLICY, observedEvidenceDigests };
}

const POLICY = policyFor();

function issueCodes(artifact: ArtifactEnvelope): string[] {
  return evaluateTruthGate(artifact, POLICY).issues.map((issue) => issue.code);
}

describe("truth gate", () => {
  it("accepts observed, fresh, contradiction-free evidence", () => {
    expect(evaluateTruthGate(verifiedArtifact(), POLICY)).toEqual({
      accepted: true,
      issues: [],
    });
  });

  it("rejects fresh tests that do not reference the exact applied action", () => {
    const artifact = { ...verifiedArtifact(), inputDigests: [digest("different-action")] };
    expect(evaluateTruthGate(artifact, policyFor(artifact))).toMatchObject({
      accepted: false,
      issues: [expect.objectContaining({ code: "missing_action_lineage" })],
    });
  });

  it("rejects a claim supported only by another agent's report", () => {
    const artifact = verifiedArtifact();
    const reportedOnly: ArtifactEnvelope = {
      ...artifact,
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        origin: "reported" as const,
      })),
    };

    expect(issueCodes(reportedOnly)).toContain("reported_only_claim");
    expect(issueCodes(reportedOnly)).toContain("reported_only_check");
  });

  it("rejects model-claimed observed evidence without a trusted receipt", () => {
    const decision = evaluateTruthGate(verifiedArtifact(), { ...POLICY, observedEvidenceDigests: {} });
    expect(decision.accepted).toBe(false);
    expect(decision.issues.map((issue) => issue.code)).toContain("untrusted_observed_evidence");
    expect(decision.issues.map((issue) => issue.code)).toContain("reported_only_check");
  });

  it("rejects stale artifact, evidence, check, and test-definition snapshots", () => {
    const artifact = verifiedArtifact();
    const stale: ArtifactEnvelope = {
      ...artifact,
      workspaceDigest: OLD_WORKSPACE_DIGEST,
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        workspaceDigest: OLD_WORKSPACE_DIGEST,
        testDigest: OLD_TEST_DEFINITION_DIGEST,
      })),
      checks: artifact.checks.map((check) => ({
        ...check,
        workspaceDigest: OLD_WORKSPACE_DIGEST,
        testDigest: OLD_TEST_DEFINITION_DIGEST,
      })),
    };

    const decision = evaluateTruthGate(stale, policyFor(stale));
    expect(decision.accepted).toBe(false);
    expect(decision.issues.filter((issue) => issue.code === "stale_workspace_digest"))
      .toHaveLength(3);
    expect(decision.issues.some((issue) => issue.code === "stale_test_digest")).toBe(
      true,
    );
  });

  it("rejects unresolved structured contradictions", () => {
    const artifact = verifiedArtifact();
    const contradicted: ArtifactEnvelope = {
      ...artifact,
      claims: [
        ...artifact.claims,
        {
          id: "claim-failure",
          statement: "Tests fail.",
          evidenceIds: ["evidence-test"],
        },
      ],
      contradictions: [
        {
          id: "conflict-test-status",
          claimIds: ["claim-tests", "claim-failure"],
          summary: "The same test run has conflicting conclusions.",
          resolved: false,
        },
      ],
    };

    expect(issueCodes(contradicted)).toContain("unresolved_contradiction");
  });

  it("rejects absent, failed, or unevidenced required checks", () => {
    const artifact = verifiedArtifact();
    expect(
      issueCodes({ ...artifact, checks: [] }),
    ).toContain("missing_required_check");

    const failed: ArtifactEnvelope = {
      ...artifact,
      checks: [
        {
          ...artifact.checks[0]!,
          status: "failed",
          evidenceIds: [],
        },
      ],
    };
    expect(issueCodes(failed)).toEqual(
      expect.arrayContaining(["required_check_not_passed", "missing_check_evidence"]),
    );
  });

  it("rejects a passed check contradicted by its observed test evidence", () => {
    const artifact = verifiedArtifact();
    const inconsistent: ArtifactEnvelope = {
      ...artifact,
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        passed: false,
      })),
    };

    expect(evaluateTruthGate(inconsistent, policyFor(inconsistent)).issues.map((issue) => issue.code))
      .toContain("inconsistent_test_evidence");
  });

  it("does not accept a test digest asserted without observed test evidence", () => {
    const artifact = verifiedArtifact();
    const commandOnly: ArtifactEnvelope = {
      ...artifact,
      evidence: [
        {
          id: "evidence-test",
          kind: "command",
          origin: "observed",
          summary: "A command was observed.",
          capturedAt: "2026-07-13T10:00:00.000Z",
          workspaceDigest: WORKSPACE_DIGEST,
          commandLabel: "test",
          exitCode: 0,
          outputDigest: TEST_OUTPUT_DIGEST,
        },
      ],
    };

    expect(evaluateTruthGate(commandOnly, policyFor(commandOnly)).issues.map((issue) => issue.code))
      .toContain("missing_check_evidence");
  });

  it("rejects command-only evidence when policy omits the required test digest", () => {
    const artifact = verifiedArtifact();
    const commandOnly: ArtifactEnvelope = {
      ...artifact,
      evidence: [{
        id: "evidence-test",
        kind: "command",
        origin: "observed",
        summary: "A command was observed.",
        capturedAt: "2026-07-13T10:00:00.000Z",
        workspaceDigest: WORKSPACE_DIGEST,
        commandLabel: "test",
        exitCode: 0,
        outputDigest: TEST_OUTPUT_DIGEST,
      }],
    };
    const { testDigests: _omitted, ...policyWithoutTestDigest } = policyFor(commandOnly);

    const decision = evaluateTruthGate(commandOnly, policyWithoutTestDigest);
    expect(decision.accepted).toBe(false);
    expect(decision.issues).toContainEqual(expect.objectContaining({
      code: "invalid_policy",
      detail: expect.stringContaining("testDigests"),
    }));
  });

  it("surfaces invalid references instead of trusting malformed envelopes", () => {
    const artifact = verifiedArtifact();
    const invalid: ArtifactEnvelope = {
      ...artifact,
      claims: [
        {
          ...artifact.claims[0]!,
          evidenceIds: ["missing"],
        },
      ],
    };

    const decision = evaluateTruthGate(invalid, POLICY);
    expect(decision.accepted).toBe(false);
    expect(decision.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_artifact" })]),
    );
  });

  it("rejects invalid runtime schema, timestamps, and kind-specific evidence", () => {
    const malformed = {
      ...verifiedArtifact(),
      schemaVersion: 99,
      createdAt: "not-a-date",
      evidence: [{
        id: "evidence-test",
        kind: "test",
        origin: "observed",
        summary: "claimed test",
        capturedAt: "not-a-date",
        checkId: "test",
        passed: true,
        testDigest: "",
        outputDigest: "",
      }],
    } as unknown as ArtifactEnvelope;
    const decision = evaluateTruthGate(malformed, POLICY);
    expect(decision.accepted).toBe(false);
    expect(decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_artifact", detail: expect.stringContaining("invalid_schema_version") }),
      expect.objectContaining({ code: "invalid_artifact", detail: expect.stringContaining("invalid_timestamp") }),
      expect.objectContaining({ code: "invalid_artifact", detail: expect.stringContaining("invalid_evidence") }),
    ]));
  });

  it("rejects same-id evidence substitution against the immutable receipt", () => {
    const artifact = verifiedArtifact();
    const substituted: ArtifactEnvelope = {
      ...artifact,
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        passed: false,
        outputDigest: digest("forged-output"),
      })),
    };

    const decision = evaluateTruthGate(substituted, POLICY);
    expect(decision.accepted).toBe(false);
    expect(decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "untrusted_observed_evidence",
        subjectId: "evidence-test",
      }),
      expect.objectContaining({ code: "reported_only_claim" }),
      expect.objectContaining({ code: "reported_only_check" }),
    ]));
  });

  it("binds test command, cwd, and exit code into the immutable receipt", () => {
    const artifact = verifiedArtifact();
    const substituted: ArtifactEnvelope = {
      ...artifact,
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        command: "npm test -- --run forged-suite",
        cwd: "/different-workspace",
        exitCode: 1,
      })),
    };

    const decision = evaluateTruthGate(substituted, POLICY);
    expect(decision.accepted).toBe(false);
    expect(decision.issues).toContainEqual(expect.objectContaining({
      code: "untrusted_observed_evidence",
      subjectId: "evidence-test",
    }));
  });

  it("never throws on malformed runtime JSON or malformed policy", () => {
    const malformedArtifacts: readonly unknown[] = [
      null,
      [],
      {},
      { ...verifiedArtifact(), evidence: null },
      { ...verifiedArtifact(), claims: [null] },
      { ...verifiedArtifact(), checks: [{ id: "test", evidenceIds: null }] },
    ];

    for (const artifact of malformedArtifacts) {
      expect(() => evaluateTruthGate(artifact, POLICY)).not.toThrow();
      expect(evaluateTruthGate(artifact, POLICY).accepted).toBe(false);
    }
    expect(() => evaluateTruthGate(verifiedArtifact(), null)).not.toThrow();
    expect(evaluateTruthGate(verifiedArtifact(), null).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_policy" }),
    );
  });
});
