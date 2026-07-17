/**
 * Wave E2 / G1.1 — optional post-edit diagnostics after successful file mutations.
 * Fail-open: never blocks the edit; appends a short evidence block for the model.
 *
 * Modes:
 * - off: never
 * - polish: only codingMode polish
 * - mutate: build / polish / deepreep / auto (not plan) — default, pairs with verify-before-done
 * - on: always (including plan if a write somehow happened)
 */

import { readdir } from "node:fs/promises";
import { detectEcosystem, runVerify } from "./verify.js";

export type PostEditVerifyMode = "off" | "on" | "polish" | "mutate";

export interface PostEditVerifyResult {
  ran: boolean;
  command?: string;
  ok?: boolean;
  output?: string;
}

/** Modes that may mutate app source via tools we track for verify-before-done. */
const MUTATE_CODING_MODES = new Set(["build", "polish", "deepreep", "auto"]);

export function shouldRunPostEditVerify(
  mode: PostEditVerifyMode | boolean | undefined,
  codingMode: string | undefined,
  opts?: { force?: boolean },
): boolean {
  if (opts?.force) return true;
  if (mode === false || mode === "off") return false;
  if (mode === true || mode === "on") return true;
  if (mode === "polish") return codingMode === "polish";
  if (mode === "mutate") {
    const m = (codingMode ?? "auto").toLowerCase();
    return MUTATE_CODING_MODES.has(m);
  }
  // Unknown / legacy unset → mutate-compatible (build+polish+auto)
  const m = (codingMode ?? "auto").toLowerCase();
  return MUTATE_CODING_MODES.has(m);
}

/**
 * Pick a single preferred verify command (typecheck > lint > test).
 */
export function preferVerifyCommand(rootFiles: string[]): string | null {
  const cmds = detectEcosystem(rootFiles);
  const tsc = cmds.find((c) => c.command.includes("tsc"));
  if (tsc) return tsc.command;
  const ruff = cmds.find((c) => c.ecosystem === "python");
  if (ruff) return ruff.command;
  const cargo = cmds.find((c) => c.ecosystem === "rust");
  if (cargo) return cargo.command;
  const go = cmds.find((c) => c.ecosystem === "go");
  if (go) return go.command;
  const npm = cmds.find((c) => c.command.includes("npm test"));
  return npm?.command ?? null;
}

export async function runPostEditVerify(opts: {
  workspace: string;
  mode?: PostEditVerifyMode | boolean;
  codingMode?: string;
  timeoutMs?: number;
  /** Wave G1.1: run regardless of mode (end-of-turn rescue for verify-before-done). */
  force?: boolean;
}): Promise<PostEditVerifyResult> {
  if (!shouldRunPostEditVerify(opts.mode, opts.codingMode, { force: opts.force })) {
    return { ran: false };
  }
  let rootFiles: string[] = [];
  try {
    rootFiles = await readdir(opts.workspace);
  } catch {
    return { ran: false };
  }
  const command = preferVerifyCommand(rootFiles);
  if (!command) return { ran: false };

  try {
    const result = await runVerify(command, opts.workspace, opts.timeoutMs ?? 90_000);
    const clipped = result.output.slice(0, 2_500);
    return {
      ran: true,
      command: result.command,
      ok: result.ok,
      output: clipped,
    };
  } catch (error) {
    return {
      ran: true,
      command,
      ok: false,
      output: `post-edit verify error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    };
  }
}

export function formatPostEditVerifyAppendix(result: PostEditVerifyResult): string {
  if (!result.ran || !result.command) return "";
  const status = result.ok ? "ok" : "failed";
  return [
    "",
    `[post-edit-verify ${status}] ${result.command}`,
    result.output ? result.output : "(no output)",
  ].join("\n");
}
