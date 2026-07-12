/**
 * Clean-context reviewer (Requirements §11.3). Reviews a diff with ONLY the diff
 * as context (no accumulated conversation), catching issues precisely because it
 * doesn't carry the writer's context. The judge (a fresh LLM call) is injected.
 */

export interface ReviewResult {
  approved: boolean;
  issues: string[];
}

export type ReviewJudge = (diff: string) => Promise<ReviewResult>;

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
