/**
 * Workspace jail (Phase 1: parity with v1 — path-prefix check).
 *
 * NOTE: full hardening (realpath/symlink resolution, Windows UNC/\\?\/junction,
 * TOCTOU mitigation) lands in Phase 6 / task 19 per design.md "Honest Limits".
 * This Phase-1 version matches the current v1 `safePath` behavior exactly.
 */

import { stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

export function safePath(workspace: string, target: string): string {
  const t = target ?? ".";
  // Windows-specific escape vectors (Property 12): drive-relative (C:rel),
  // UNC (\\server\share), device/extended namespace (\\?\, \\.\).
  if (/^[a-zA-Z]:(?![\\/])/.test(t)) throw new Error(`Drive-relative путь запрещён: ${target}`);
  if (/^\\\\/.test(t) || /^\/\//.test(t)) throw new Error(`UNC/device путь запрещён: ${target}`);
  const abs = resolve(workspace, t);
  const rel = relative(workspace, abs);
  // rel === "" means target IS the workspace root. An absolute rel means a
  // different drive/root (cross-drive escape). ".." means parent escape.
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`Путь вне рабочей папки запрещён: ${target}`);
  }
  return abs;
}

export async function isWorkspaceDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
