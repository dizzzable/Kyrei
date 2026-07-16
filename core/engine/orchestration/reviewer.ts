/**
 * Clean-context reviewer (Requirements §11.3). Reviews a diff with ONLY the diff
 * as context (no accumulated conversation), catching issues precisely because it
 * doesn't carry the writer's context. The judge (a fresh LLM call) is injected.
 */

import { generateText, Output as AiOutput, type LanguageModel } from "ai";
import { z } from "zod";

export interface ReviewResult {
  approved: boolean;
  issues: string[];
  severity?: "warning" | "error";
}

export type ReviewJudge = (diff: string) => Promise<ReviewResult>;

const REVIEW_PROMPT = `You are a code review security judge. You see ONLY the proposed diff—no conversation history.

Your job: flag issues the writer might have missed due to context tunnel vision.

Check for:
- Hardcoded secrets (API keys, tokens, passwords, credentials in plain text)
- Disabled security checks (auth bypass, validation skip, commented-out guards)
- Dangerous patterns (eval, exec, SQL injection vectors, command injection)
- Unintended file operations (writing outside workspace, path traversal)
- Suspicious TODOs/FIXMEs that indicate incomplete security work

Output JSON: {"approved": boolean, "issues": string[], "severity": "warning"|"error"}

Be precise. False positives are expensive (block valid work). False negatives are dangerous (miss real issues).
If uncertain, approve with a warning—human can review in git history.
Approve clean refactors, dependency updates, and documentation changes without hesitation.`;

const ReviewResultSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()),
  severity: z.enum(["warning", "error"]).optional(),
});

/**
 * Races a generation promise against a combined deadline signal. Some
 * providers ignore AbortSignal and keep the HTTP request open; racing here
 * ensures the judge still returns (fail-open) promptly instead of hanging.
 */
function raceAgainstSignal<T>(generation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    generation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Create a real LLM-based review judge (replaces regex stub). Sees only the diff
 * in a fresh context (no conversation history). Uses structured output for
 * reliability. Fails open on errors (never blocks valid work due to infra issues).
 */
export function createReviewJudge(
  model: LanguageModel,
  abortSignal?: AbortSignal,
  timeoutMs = 30_000,
): ReviewJudge {
  return async (diff: string): Promise<ReviewResult> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutSignal])
      : timeoutSignal;

    try {
      const result = await raceAgainstSignal(
        generateText({
          model,
          messages: [
            { role: "system", content: REVIEW_PROMPT },
            { role: "user", content: `Review this diff:\n\n${diff}` },
          ],
          output: AiOutput.object({ schema: ReviewResultSchema }),
          maxOutputTokens: 1000,
          abortSignal: combinedSignal,
        }),
        combinedSignal,
      );

      const parsed = result.output;
      return {
        approved: parsed.approved,
        issues: parsed.issues,
        severity: parsed.severity,
      };
    } catch (err) {
      // Fail-open: if review infra breaks, don't block valid work
      console.warn("[kyrei] Review judge failed, approving with warning:", err);
      return {
        approved: true,
        issues: [`Review skipped due to error: ${err instanceof Error ? err.message : String(err)}`],
        severity: "warning",
      };
    }
  };
}

export async function reviewDiff(diff: string, judge: ReviewJudge): Promise<ReviewResult> {
  if (!diff.trim()) return { approved: true, issues: [] };
  return judge(diff);
}

/**
 * Read-only subagent contract (Requirements §11.1, §11.2). Writes are done by a
 * single writer; subagents only read/search and return a compact summary. The
 * actual run is injected so orchestration stays testable and single-writer safe.
 * A leaf subagent MUST NOT re-delegate (enforced by omitting delegation tools).
 */
export interface SubagentSpec {
  goal: string;
  readOnly: true;
}
export type SubagentRunner = (spec: SubagentSpec) => Promise<{ summary: string }>;

export async function runReadSwarm(specs: SubagentSpec[], run: SubagentRunner): Promise<string[]> {
  const results = await Promise.all(specs.map((s) => run(s)));
  return results.map((r) => r.summary);
}
