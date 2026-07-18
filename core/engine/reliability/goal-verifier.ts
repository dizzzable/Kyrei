/**
 * Goal verifier (Phase 4). Requirements §9.3. Independent check that the
 * completion condition is actually satisfied before declaring "done".
 * The judge (a cheap LLM call) is injected so this stays pure/testable.
 */

export interface GoalVerdict {
  satisfied: boolean;
  gap?: string;
  /** The judge could not produce a semantic verdict (provider/parser/runtime failure). */
  unavailable?: boolean;
}

export type GoalJudge = (condition: string, transcript: string) => Promise<GoalVerdict>;

export async function verifyGoal(
  condition: string | undefined,
  transcript: string,
  judge: GoalJudge,
): Promise<GoalVerdict> {
  if (!condition || !condition.trim()) return { satisfied: true }; // no explicit goal → allow stop
  return judge(condition, transcript);
}
