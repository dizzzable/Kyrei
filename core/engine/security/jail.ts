/**
 * Workspace jail. `safePath` performs fast lexical confinement for reads;
 * `validateWriteTarget` additionally inspects the live filesystem before
 * mutation and rejects symlink/junction/reparse and Windows alias escapes.
 * Repeated validation narrows but cannot eliminate filesystem TOCTOU races.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";

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

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertPortableWriteName(workspace: string, absoluteTarget: string, originalTarget: string): void {
  if (originalTarget.includes("\0")) {
    throw new Error("Write target contains a null byte");
  }
  if (process.platform !== "win32") return;

  const rel = relative(workspace, absoluteTarget);
  const components = rel === "" ? [] : rel.split(/[\\/]/);
  for (const component of components) {
    if (component.includes(":")) {
      throw new Error(`Windows ADS alias is forbidden in write target: ${originalTarget}`);
    }
    if (/[. ]$/.test(component)) {
      throw new Error(`Windows trailing dot/space alias is forbidden in write target: ${originalTarget}`);
    }
  }
}

async function verifyExistingWritePrefix(
  workspace: string,
  workspaceReal: string,
  components: readonly string[],
  originalTarget: string,
): Promise<void> {
  let nearestExisting = workspace;

  for (let index = 0; index < components.length; index += 1) {
    const current = resolve(workspace, ...components.slice(0, index + 1));
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }

    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic link, junction, or reparse component is forbidden in write target: ${originalTarget}`);
    }

    const currentReal = await realpath(current);
    if (!isInside(workspaceReal, currentReal)) {
      throw new Error(`Resolved write target escapes the workspace: ${originalTarget}`);
    }

    // A path-changing reparse point can redirect realpath without being exposed
    // as a POSIX-style symbolic link by every Windows filesystem provider.
    const expectedReal = resolve(workspaceReal, ...components.slice(0, index + 1));
    if (relative(expectedReal, currentReal) !== "") {
      throw new Error(`Reparse component or filesystem alias is forbidden in write target: ${originalTarget}`);
    }

    nearestExisting = current;
  }

  const parentReal = await realpath(nearestExisting);
  if (!isInside(workspaceReal, parentReal)) {
    throw new Error(`Nearest existing write parent escapes the workspace: ${originalTarget}`);
  }
}

/**
 * Validate a file or directory immediately before a write operation.
 *
 * Unlike `safePath`, this checks the live filesystem: every existing target
 * component must be an ordinary path below the canonical workspace root. The
 * second pass deliberately avoids caching validation across calls and narrows
 * (but cannot eliminate) the validation/write TOCTOU window.
 */
export async function validateWorkspaceTarget(workspace: string, target: string): Promise<string> {
  const workspaceAbsolute = resolve(workspace);
  const absoluteTarget = safePath(workspaceAbsolute, target);
  assertPortableWriteName(workspaceAbsolute, absoluteTarget, target);

  const workspaceReal = await realpath(workspaceAbsolute);
  const rel = relative(workspaceAbsolute, absoluteTarget);
  const components = rel === "" ? [] : rel.split(sep);

  await verifyExistingWritePrefix(workspaceAbsolute, workspaceReal, components, target);
  await verifyExistingWritePrefix(workspaceAbsolute, workspaceReal, components, target);
  return absoluteTarget;
}

/** Backward-compatible mutation-specific name used at write call sites. */
export const validateWriteTarget = validateWorkspaceTarget;

export async function isWorkspaceDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
