/**
 * Wave G1 — verify-before-done gate.
 *
 * If the turn mutated workspace files and claims success, require observable
 * verify evidence (post-edit-verify, diagnostics, test/typecheck commands).
 * Fail-closed only for "complete"; never invent tool results.
 */

export interface ToolLikePart {
  type?: string;
  name?: string;
  result?: string;
  error?: string;
}

const MUTATE_TOOLS = new Set(["edit_file", "write_file"]);

const VERIFY_TOOL_NAMES = new Set(["diagnostics"]);

const VERIFY_RESULT_MARKERS = [
  /\[post-edit-verify\b/i,
  /\btsc --noEmit\b/i,
  /\bnpm test\b/i,
  /\bcargo (check|test)\b/i,
  /\bgo (test|build)\b/i,
  /\bruff check\b/i,
  /\bpytest\b/i,
  /Typecheck|typecheck|lint (ok|passed|failed)/i,
];

const VERIFY_COMMAND_MARKERS = [
  /\btsc\b/i,
  /\bnpm (test|run test)\b/i,
  /\bcargo (check|test)\b/i,
  /\bgo (test|build)\b/i,
  /\bruff\b/i,
  /\bpytest\b/i,
  /\beslint\b/i,
];

function toolParts(parts: readonly ToolLikePart[]): ToolLikePart[] {
  return parts.filter((p) => p && p.type === "tool" && typeof p.name === "string");
}

/** Successful edit_file / write_file without tool error. */
export function turnHadFileMutations(parts: readonly ToolLikePart[]): boolean {
  return toolParts(parts).some((p) => {
    if (!MUTATE_TOOLS.has(p.name ?? "")) return false;
    if (p.error) return false;
    const r = typeof p.result === "string" ? p.result : "";
    // Apply/write failures often still return a string without throwing.
    if (/Правка отклонена|denied|failed|error/i.test(r) && !/post-edit-verify/i.test(r)) {
      // Still count as mutation if file was written: "Файл обновлён" / "created"
      if (/Файл (создан|обновлён)|file (created|updated)|Applied \d+ file/i.test(r)) return true;
      return false;
    }
    return true;
  });
}

/** Observable verify evidence in tool results or run_command args/results. */
export function turnHasVerifyEvidence(parts: readonly ToolLikePart[], assistantText = ""): boolean {
  for (const p of toolParts(parts)) {
    if (p.error) continue;
    const name = p.name ?? "";
    const result = typeof p.result === "string" ? p.result : "";
    if (VERIFY_TOOL_NAMES.has(name)) return true;
    if (name === "run_command") {
      if (VERIFY_COMMAND_MARKERS.some((re) => re.test(result))) return true;
      // post-edit appends to edit_file result, not run_command
    }
    if (VERIFY_RESULT_MARKERS.some((re) => re.test(result))) return true;
  }
  // Final audit / explicit verify markers in assistant text alone are not enough
  // without tools — require tool evidence for workspace claims.
  if (/KYREI_FINAL_AUDIT|KYREI_RUN_COMPLETE/.test(assistantText)
    && toolParts(parts).some((p) => p.name === "run_command" || p.name === "diagnostics")) {
    return true;
  }
  return false;
}

export interface VerifyBeforeDoneDecision {
  /** True when the gate fires (turn should not stay pure complete). */
  blocked: boolean;
  reason: string;
}

/**
 * @param enabled config.reliability.verifyBeforeDone
 * @param codingMode plan mode rarely mutates app source via tools we track
 */
export function evaluateVerifyBeforeDone(opts: {
  enabled: boolean;
  status: string;
  codingMode?: string;
  parts: readonly ToolLikePart[];
  assistantText?: string;
}): VerifyBeforeDoneDecision {
  if (!opts.enabled) return { blocked: false, reason: "disabled" };
  if (opts.status !== "complete") return { blocked: false, reason: "not_complete" };
  if (opts.codingMode === "plan") return { blocked: false, reason: "plan_mode" };
  if (!turnHadFileMutations(opts.parts)) return { blocked: false, reason: "no_mutations" };
  if (turnHasVerifyEvidence(opts.parts, opts.assistantText ?? "")) {
    return { blocked: false, reason: "verified" };
  }
  return {
    blocked: true,
    reason: "mutations_without_verify",
  };
}

export function verifyBeforeDoneMessage(locale: "en" | "ru" = "en"): string {
  if (locale === "ru") {
    return "\n\n[verify-before-done] В этом ходе были правки файлов, но нет evidence typecheck/tests/diagnostics. "
      + "Запустите diagnostics или tsc/npm test (или включите post-edit verify), затем подтвердите done.";
  }
  return "\n\n[verify-before-done] This turn edited files without typecheck/tests/diagnostics evidence. "
    + "Run diagnostics or tsc/npm test (or enable post-edit verify), then re-claim done.";
}
