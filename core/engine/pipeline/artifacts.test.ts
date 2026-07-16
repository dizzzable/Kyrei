import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactValidationError,
  createArtifactEnvelope,
  indexEvidence,
  validateArtifactEnvelope,
} from "./artifacts.js";
import type { ArtifactEnvelope } from "./types.js";

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const WORKSPACE_DIGEST = digest("workspace-a");
const BUILD_OUTPUT_DIGEST = digest("output-build");

function validArtifact(): ArtifactEnvelope {
  return {
    schemaVersion: 1,
    id: "artifact-1",
    kind: "verification",
    runId: "run-1",
    stageId: "verify-1",
    producerId: "test-team",
    createdAt: "2026-07-13T10:00:00.000Z",
    summary: "The build and tests pass.",
    workspaceDigest: WORKSPACE_DIGEST,
    inputDigests: [digest("input-artifact")],
    assumptions: ["The checked workspace is the requested workspace."],
    uncertainties: [],
    unchecked: ["Remote deployment was not exercised."],
    provenance: {
      providerId: "test-provider",
      modelId: "test-model",
      policyDigest: digest("artifact-policy"),
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
        id: "claim-build",
        statement: "The build succeeds.",
        evidenceIds: ["command-build"],
      },
    ],
    evidence: [
      {
        id: "command-build",
        kind: "command",
        origin: "observed",
        summary: "Build exited successfully.",
        capturedAt: "2026-07-13T10:00:00.000Z",
        workspaceDigest: WORKSPACE_DIGEST,
        commandLabel: "build",
        exitCode: 0,
        outputDigest: BUILD_OUTPUT_DIGEST,
      },
    ],
    checks: [
      {
        id: "build",
        status: "passed",
        evidenceIds: ["command-build"],
        workspaceDigest: WORKSPACE_DIGEST,
      },
    ],
    contradictions: [],
  };
}

describe("artifact envelopes", () => {
  it("accepts a structurally sound hand-off and indexes its evidence", () => {
    const artifact = validArtifact();
    expect(validateArtifactEnvelope(artifact)).toEqual({ valid: true, issues: [] });
    expect(indexEvidence(artifact).get("command-build")?.kind).toBe("command");
  });

  it("defensively copies nested hand-off collections", () => {
    const source = validArtifact();
    const created = createArtifactEnvelope(source);

    expect(created).not.toBe(source);
    expect(created.claims).not.toBe(source.claims);
    expect(created.claims[0]?.evidenceIds).not.toBe(source.claims[0]?.evidenceIds);
    expect(created.evidence).not.toBe(source.evidence);
    expect(created.checks).not.toBe(source.checks);
  });

  it("projects the allowlisted schema instead of copying non-JSON extras", () => {
    const hiddenCredential = Symbol("apiKey");
    const artifact = validArtifact();
    const source = {
      ...artifact,
      [hiddenCredential]: "root-secret",
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        [hiddenCredential]: "evidence-secret",
      })),
    } as ArtifactEnvelope;

    const created = createArtifactEnvelope(source);
    expect(Reflect.ownKeys(created)).not.toContain(hiddenCredential);
    expect(Reflect.ownKeys(created.evidence[0]!)).not.toContain(hiddenCredential);
  });

  it("reports duplicate identities and dangling references deterministically", () => {
    const artifact = validArtifact();
    const invalid: ArtifactEnvelope = {
      ...artifact,
      claims: [
        artifact.claims[0]!,
        {
          id: "claim-build",
          statement: "Duplicate",
          evidenceIds: ["missing-evidence"],
        },
      ],
    };

    expect(validateArtifactEnvelope(invalid).issues).toEqual([
      {
        code: "duplicate_claim_id",
        field: "claims",
        id: "claim-build",
      },
      {
        code: "dangling_evidence_ref",
        field: "claims.evidenceIds",
        id: "claim-build",
        referencedId: "missing-evidence",
      },
    ]);
    expect(() => createArtifactEnvelope(invalid)).toThrow(ArtifactValidationError);
  });

  it("requires contradictions to reference claims and resolved ones to explain resolution", () => {
    const artifact = validArtifact();
    const invalid: ArtifactEnvelope = {
      ...artifact,
      contradictions: [
        {
          id: "conflict-1",
          claimIds: ["claim-build", "missing-claim"],
          summary: "Conflicting results",
          resolved: true,
        },
      ],
    };

    expect(validateArtifactEnvelope(invalid).issues).toEqual([
      {
        code: "invalid_contradiction",
        field: "contradictions.resolution",
        id: "conflict-1",
      },
      {
        code: "dangling_claim_ref",
        field: "contradictions.claimIds",
        id: "conflict-1",
        referencedId: "missing-claim",
      },
    ]);
  });

  it("rejects malformed JSON shapes without throwing", () => {
    const artifact = validArtifact();
    const malformed: readonly unknown[] = [
      null,
      [],
      {},
      { ...artifact, claims: null },
      { ...artifact, evidence: [null] },
      { ...artifact, checks: [{ id: "check", evidenceIds: null }] },
      { ...artifact, contradictions: ["not-an-object"] },
    ];

    for (const candidate of malformed) {
      expect(() => validateArtifactEnvelope(candidate)).not.toThrow();
      expect(validateArtifactEnvelope(candidate).valid).toBe(false);
    }
  });

  it("bounds untrusted collections", () => {
    const artifact = validArtifact();
    const oversized = {
      ...artifact,
      claims: Array.from({ length: 2_001 }, (_, index) => ({
        id: `claim-${index}`,
        statement: "Bounded claim",
        evidenceIds: ["command-build"],
      })),
    };

    expect(validateArtifactEnvelope(oversized).issues).toContainEqual({
      code: "collection_too_large",
      field: "claims",
    });
  });

  it("requires SHA-256 encoding for every supplied digest", () => {
    const artifact = validArtifact();
    const invalid = {
      ...artifact,
      workspaceDigest: "workspace-a",
      inputDigests: ["not-an-input-sha256"],
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        outputDigest: "not-a-sha256",
      })),
    };

    expect(validateArtifactEnvelope(invalid).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_digest", field: "workspaceDigest" }),
      expect.objectContaining({ code: "invalid_digest", field: "inputDigests[0]" }),
      expect.objectContaining({ code: "invalid_digest", field: "evidence.command.outputDigest" }),
    ]));
  });

  it("rejects unknown root fields instead of accepting a raw provider transcript", () => {
    const smuggled = {
      ...validArtifact(),
      rawProviderTranscript: "private provider response",
    };

    expect(validateArtifactEnvelope(smuggled).issues).toContainEqual({
      code: "unknown_field",
      field: "rawProviderTranscript",
    });
    expect(() => createArtifactEnvelope(smuggled)).toThrow(ArtifactValidationError);
  });

  it("rejects credential-shaped unknown fields inside evidence", () => {
    const artifact = validArtifact();
    const smuggled = {
      ...artifact,
      evidence: artifact.evidence.map((evidence) => ({
        ...evidence,
        apiKey: "short-secret",
      })),
    };

    expect(validateArtifactEnvelope(smuggled).issues).toContainEqual({
      code: "unknown_field",
      field: "evidence[0].apiKey",
      id: "command-build",
    });
    expect(() => createArtifactEnvelope(smuggled)).toThrow(ArtifactValidationError);
  });

  it("rejects artifacts above the total serialized byte cap", () => {
    const oversized = {
      ...validArtifact(),
      summary: "x".repeat(600_000),
    };

    expect(validateArtifactEnvelope(oversized)).toEqual({
      valid: false,
      issues: [{ code: "artifact_too_large", field: "artifact" }],
    });
  });

  it("validates structured provenance and token/timing metrics", () => {
    const artifact = validArtifact();
    const invalid = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        policyDigest: "not-a-digest",
        apiKey: "must-not-cross-boundary",
      },
      metrics: {
        ...artifact.metrics,
        inputTokens: 10,
        totalTokens: 999,
        providerCalls: -1,
        durationMs: "fast",
      },
    };

    expect(validateArtifactEnvelope(invalid).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown_field", field: "provenance.apiKey" }),
      expect.objectContaining({ code: "invalid_digest", field: "provenance.policyDigest" }),
      expect.objectContaining({ code: "invalid_metric", field: "metrics.totalTokens" }),
      expect.objectContaining({ code: "invalid_metric", field: "metrics.providerCalls" }),
      expect.objectContaining({ code: "invalid_metric", field: "metrics.durationMs" }),
    ]));
  });

  function samplePatch(body = "+hello\n"): string {
    return `*** Begin Patch\n*** Add File: notes/hello.txt\n${body}*** End Patch\n`;
  }

  function patchDigest(patch: string): string {
    return createHash("sha256").update(patch, "utf8").digest("hex");
  }

  function artifactWithPatch(patch: string, digest = patchDigest(patch)): ArtifactEnvelope {
    return {
      ...validArtifact(),
      kind: "department",
      evidence: [
        {
          id: "applicable-patch",
          kind: "patch",
          origin: "reported",
          summary: "Applicable implementation patch",
          capturedAt: "2026-07-13T10:00:00.000Z",
          workspaceDigest: WORKSPACE_DIGEST,
          patch,
          patchDigest: digest,
        },
      ],
      claims: [],
      checks: [],
    };
  }

  it("accepts patch evidence and round-trips through createArtifactEnvelope", () => {
    const patch = samplePatch("+line one\n+line two\n");
    const source = artifactWithPatch(patch);
    expect(validateArtifactEnvelope(source)).toEqual({ valid: true, issues: [] });
    const created = createArtifactEnvelope(source);
    expect(created.evidence[0]).toMatchObject({
      kind: "patch",
      patch,
      patchDigest: patchDigest(patch),
    });
    expect(created.evidence[0]).not.toBe(source.evidence[0]);
  });

  it("rejects patch evidence that is too large, digests mismatch, empty, or escapes workspace", () => {
    const valid = samplePatch();
    const oversized = samplePatch(`+${"x".repeat(70_000)}\n`);
    expect(validateArtifactEnvelope(artifactWithPatch(oversized)).issues).toContainEqual(
      expect.objectContaining({ code: "field_too_large", field: "evidence.patch" }),
    );
    expect(validateArtifactEnvelope(artifactWithPatch(valid, "0".repeat(64))).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_digest", field: "evidence.patchDigest" }),
    );
    expect(validateArtifactEnvelope(artifactWithPatch("*** Begin Patch\n*** End Patch\n")).issues)
      .toContainEqual(expect.objectContaining({ code: "invalid_evidence", field: "evidence.patch" }));
    const absolute = "*** Begin Patch\n*** Add File: /etc/passwd\n+x\n*** End Patch\n";
    expect(validateArtifactEnvelope(artifactWithPatch(absolute)).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_evidence", field: "evidence.patch.path" }),
    );
    const parent = "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch\n";
    expect(validateArtifactEnvelope(artifactWithPatch(parent)).issues).toContainEqual(
      expect.objectContaining({ code: "invalid_evidence", field: "evidence.patch.path" }),
    );
  });
});
