import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// Safety evidence covers every writable path by default. Callers may opt into
// exclusions only for non-security uses; retry admission never supplies any.
const DEFAULT_IGNORED_NAMES = new Set();

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function frame(hash, value) {
  const bytes = Buffer.from(String(value));
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

function stableNameOrder(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function sameNode(left, right) {
  return left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ino === right.ino;
}

function permissionBits(mode) {
  if (typeof mode === "bigint") return mode & 0o7777n;
  // Electron on Windows can return a legacy numeric Stats object for a
  // directory even when lstat requested bigint fields. Normalize that mixed
  // runtime shape before hashing so evidence stays deterministic.
  if (typeof mode === "number" && Number.isSafeInteger(mode) && mode >= 0) {
    return BigInt(mode) & 0o7777n;
  }
  throw evidenceError("pipeline_workspace_evidence_metadata_invalid");
}

async function hashFileContents(hash, path) {
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectStream);
    stream.once("end", resolveStream);
  });
}

/**
 * Produce a deterministic, gateway-observed digest without following links.
 * It follows no symlinks and fails closed when explicit resource bounds are
 * exceeded. Every writable directory is included by default.
 */
export async function observeWorkspace(workspace, {
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  ignoredNames = DEFAULT_IGNORED_NAMES,
} = {}) {
  if (typeof workspace !== "string" || !workspace.trim() || workspace.includes("\0")) {
    throw evidenceError("pipeline_workspace_evidence_path_invalid");
  }
  const root = await realpath(resolve(workspace.trim())).catch(() => {
    throw evidenceError("pipeline_workspace_evidence_path_unavailable");
  });
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory()) throw evidenceError("pipeline_workspace_evidence_path_invalid");
  const entryLimit = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
  const byteLimit = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const ignored = ignoredNames instanceof Set ? ignoredNames : new Set(ignoredNames);
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  let excluded = 0;

  async function walk(path) {
    const before = await lstat(path, { bigint: true });
    const rel = relative(root, path).replaceAll("\\", "/") || ".";
    entries += 1;
    if (entries > entryLimit) throw evidenceError("pipeline_workspace_evidence_limit");

    if (before.isSymbolicLink()) {
      frame(hash, "link");
      frame(hash, rel);
      frame(hash, permissionBits(before.mode));
      frame(hash, await readlink(path));
      return;
    }
    if (before.isDirectory()) {
      frame(hash, "directory");
      frame(hash, rel);
      frame(hash, permissionBits(before.mode));
      const children = (await readdir(path, { withFileTypes: true })).sort(stableNameOrder);
      for (const child of children) {
        const childPath = join(path, child.name);
        if (ignored.has(child.name) && child.isDirectory() && !child.isSymbolicLink()) {
          entries += 1;
          excluded += 1;
          if (entries > entryLimit) throw evidenceError("pipeline_workspace_evidence_limit");
          frame(hash, "excluded-directory");
          frame(hash, relative(root, childPath).replaceAll("\\", "/"));
          continue;
        }
        await walk(childPath);
      }
      const after = await lstat(path, { bigint: true });
      if (!sameNode(before, after)) throw evidenceError("pipeline_workspace_changed_during_evidence");
      return;
    }
    if (before.isFile()) {
      const size = Number(before.size);
      bytes += size;
      if (!Number.isSafeInteger(size) || bytes > byteLimit) throw evidenceError("pipeline_workspace_evidence_limit");
      frame(hash, "file");
      frame(hash, rel);
      frame(hash, permissionBits(before.mode));
      frame(hash, size);
      hash.update("content:");
      await hashFileContents(hash, path);
      hash.update(";");
      const after = await lstat(path, { bigint: true });
      if (!sameNode(before, after)) throw evidenceError("pipeline_workspace_changed_during_evidence");
      return;
    }
    frame(hash, "other");
    frame(hash, rel);
  }

  await walk(root);
  return {
    algorithm: "kyrei-workspace-sha256-v1",
    digest: hash.digest("hex"),
    entries,
    bytes,
    excluded,
    observedAt: new Date().toISOString(),
  };
}

export {
  DEFAULT_IGNORED_NAMES as WORKSPACE_EVIDENCE_IGNORED_NAMES,
  DEFAULT_MAX_BYTES as WORKSPACE_EVIDENCE_MAX_BYTES,
  DEFAULT_MAX_ENTRIES as WORKSPACE_EVIDENCE_MAX_ENTRIES,
  permissionBits as workspacePermissionBits,
};
