import type {
  TeamArtifact,
  TeamClarificationRequest,
  TeamComparison,
  TeamComparisonClaim,
  TeamComparisonConflict,
  TeamTaskResult,
} from "./types.js";

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function comparableGoal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueQuestions(results: readonly TeamArtifact[]): TeamClarificationRequest[] {
  const out: TeamClarificationRequest[] = [];
  const seen = new Set<string>();
  for (const artifact of results) {
    for (const request of artifact.clarificationRequests ?? []) {
      const question = request.question.trim();
      if (!question) continue;
      const key = question.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: request.id.trim() || `clarification-${out.length + 1}`,
        question: question.slice(0, 2_000),
        context: request.context.trim().slice(0, 4_000),
        ...(request.options?.length
          ? {
              options: request.options.slice(0, 8).map((option) => ({
                id: option.id.trim().slice(0, 80),
                label: option.label.trim().slice(0, 300),
                ...(option.impact ? { impact: option.impact.trim().slice(0, 600) } : {}),
              })),
            }
          : {}),
        ...(request.recommended ? { recommended: request.recommended.trim().slice(0, 80) } : {}),
        blocking: request.blocking === true,
      });
    }
  }
  return out.slice(0, 8);
}

/**
 * Deterministic comparison for independent Team artifacts.
 *
 * It deliberately does not pretend to understand arbitrary natural-language
 * claims. Low lexical agreement is a verifier signal, never proof of a
 * contradiction; semantic resolution stays with a critic, tests, or human.
 */
export function compareTeamResults(
  results: readonly TeamTaskResult[],
  mode: "consensus" | "department" | "supervisor" = "consensus",
): TeamComparison {
  const succeeded = results.filter(
    (result): result is Extract<TeamTaskResult, { status: "succeeded" }> => result.status === "succeeded",
  );
  const claims: TeamComparisonClaim[] = succeeded.map((result, index) => ({
    id: `claim-${index + 1}-${result.task.id}`.slice(0, 160),
    taskId: result.task.id,
    summary: result.artifact.summary.slice(0, 2_400),
    confidence: result.artifact.confidence,
    evidence: result.artifact.evidence.slice(0, 8),
    provenance: result.artifact.provenance.slice(0, 6),
  }));
  const conflicts: TeamComparisonConflict[] = [];
  let pairCount = 0;
  let similarityTotal = 0;
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const leftResult = succeeded[left];
      const rightResult = succeeded[right];
      if (
        mode === "supervisor"
        && comparableGoal(leftResult?.task.goal ?? "") !== comparableGoal(rightResult?.task.goal ?? "")
      ) {
        continue;
      }
      const score = similarity(claims[left]!.summary, claims[right]!.summary);
      pairCount += 1;
      similarityTotal += score;
      if (score < 0.22) {
        conflicts.push({
          id: `conflict-${conflicts.length + 1}`,
          claimIds: [claims[left]!.id, claims[right]!.id],
          summary: `Independent results diverge between ${claims[left]!.taskId} and ${claims[right]!.taskId}.`,
          resolved: false,
        });
      }
    }
  }
  const clarificationRequests = uniqueQuestions(succeeded.map((result) => result.artifact));
  const failed = results.some((result) => result.status !== "succeeded");
  const agreementScore = pairCount ? Number((similarityTotal / pairCount).toFixed(3)) : 1;
  const decision: TeamComparison["decision"] =
    clarificationRequests.some((request) => request.blocking)
      ? "needs_human"
      : conflicts.length || failed
        ? "needs_verification"
        : "converged";
  return {
    version: 1,
    decision,
    agreementScore,
    claims,
    conflicts: mode === "consensus" || mode === "department" || mode === "supervisor"
      ? conflicts.slice(0, 16)
      : [],
    clarificationRequests,
  };
}
