import { describe, expect, it } from "vitest";

import { compareTeamResults } from "./comparison.js";
import type { TeamArtifact, TeamTaskResult } from "./types.js";

function result(
  taskId: string,
  summary: string,
  extra: Partial<TeamArtifact> = {},
): TeamTaskResult {
  return {
    task: { id: taskId, goal: `Goal for ${taskId}` },
    status: "succeeded",
    artifact: {
      taskId,
      summary,
      provenance: [`provider:${taskId}`],
      confidence: 0.8,
      evidence: [`reported:${taskId}`],
      validation: ["reviewed"],
      uncertainties: [],
      whatWasNotChecked: [],
      ...extra,
    },
  };
}

describe("compareTeamResults", () => {
  it("marks materially different independent summaries for verification", () => {
    const comparison = compareTeamResults([
      result("researcher", "Use SQLite FTS and verify checksums before merging."),
      result("critic", "Deploy a remote graph service and skip deterministic tests."),
    ]);

    expect(comparison.decision).toBe("needs_verification");
    expect(comparison.conflicts).toHaveLength(1);
    expect(comparison.conflicts[0]?.claimIds).toHaveLength(2);
    expect(comparison.claims).toHaveLength(2);
  });

  it("converges when parallel roles reach the same conclusion", () => {
    const comparison = compareTeamResults([
      result("researcher", "Keep the read-only memory index and verify the workspace digest."),
      result("reviewer", "Keep the existing memory index while verifying workspace digest."),
    ], "department");

    expect(comparison.decision).toBe("converged");
    expect(comparison.conflicts).toEqual([]);
    expect(comparison.agreementScore).toBeGreaterThan(0.22);
  });

  it("deduplicates blocking human questions and raises a human decision", () => {
    const question = {
      id: "intent",
      question: "Which module outcome should be prioritized?",
      context: "Two valid designs have different product trade-offs.",
      options: [{ id: "a", label: "Reliability", impact: "More verification." }],
      recommended: "a",
      blocking: true,
    } as const;
    const comparison = compareTeamResults([
      result("a", "Option A is safer.", { clarificationRequests: [question] }),
      result("b", "Option B is faster.", { clarificationRequests: [{ ...question, id: "intent-copy" }] }),
    ]);

    expect(comparison.decision).toBe("needs_human");
    expect(comparison.clarificationRequests).toHaveLength(1);
    expect(comparison.clarificationRequests[0]).toMatchObject({
      question: question.question,
      blocking: true,
    });
  });
});
