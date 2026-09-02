/**
 * Locate the ripgrep binary in a way that survives Electron packaging.
 *
 * THE BUG THIS EXISTS FOR
 *
 * `@vscode/ripgrep` resolves its binary with `require.resolve`, which inside a
 * packaged app returns a path THROUGH the archive:
 *
 *   …/resources/app.asar/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe
 *
 * Electron transparently serves file READS from `app.asar.unpacked`, but
 * `spawn` goes to the OS, and the OS cannot execute a path inside an archive:
 *
 *   spawn …\app.asar\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe ENOENT
 *
 * The binary is present and correct — electron-builder unpacks it, as
 * `asarUnpack` requires — only the path is wrong. Every `grep_search` failed,
 * which matters most for read-only research subagents whose entire job is
 * search: the tool is in their allowlist, so each one discovered the breakage by
 * calling it and burning a step out of its budget.
 *
 * Rewriting the one path segment is the whole fix. Resolution is done once at
 * module load: the answer cannot change while the process runs, and a failure
 * must not be re-derived on every call.
 */

import { existsSync } from "node:fs";
import { rgPath as resolvedRgPath } from "@vscode/ripgrep";

/** `…/app.asar/…` → `…/app.asar.unpacked/…`, preserving the separator style. */
function unpackedCandidate(path: string): string | undefined {
  // Match the archive segment only, never a directory that merely starts with
  // it: `app.asar.unpacked` itself must not be rewritten a second time.
  const pattern = /([\\/])app\.asar([\\/])/;
  if (!pattern.test(path)) return undefined;
  return path.replace(pattern, (_match, before: string, after: string) => `${before}app.asar.unpacked${after}`);
}

function resolveRipgrepPath(candidate: string): { path: string; unavailable?: string } {
  if (existsSync(candidate)) return { path: candidate };

  const unpacked = unpackedCandidate(candidate);
  if (unpacked && existsSync(unpacked)) return { path: unpacked };

  // Report both paths: which one was tried is the entire diagnosis, and a
  // packaging regression is otherwise indistinguishable from a missing binary.
  const tried = unpacked ? `${candidate} and ${unpacked}` : candidate;
  return { path: candidate, unavailable: `ripgrep binary not found (tried ${tried})` };
}

const resolution = resolveRipgrepPath(resolvedRgPath);

/** Absolute path to an executable ripgrep, or the original path when missing. */
export const ripgrepPath = resolution.path;

/**
 * Human-readable reason `grep_search` cannot run, or undefined when it can.
 *
 * Exported so a subagent's system context can state the degradation once,
 * up front, instead of every child rediscovering it mid-run.
 */
export const ripgrepUnavailableReason = resolution.unavailable;

export function isRipgrepAvailable(): boolean {
  return resolution.unavailable === undefined;
}
