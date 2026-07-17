import { resolve } from "node:path";

/** Canonical path used when persisting MemoryDoc.workspace on disk. */
export function normalizeWorkspaceTag(value: string): string {
  return resolve(value.trim());
}

/** Compare workspace tags across slash/case variants (notably Windows). */
export function sameWorkspaceTag(left: string | undefined, right: string): boolean {
  if (!left?.trim() || !right.trim()) return false;
  const a = normalizeWorkspaceTag(left);
  const b = normalizeWorkspaceTag(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
