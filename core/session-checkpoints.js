import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SNAPSHOT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_SNAPSHOTS = 512;
const MAX_FILES = 512;
const MAX_TOTAL_FILES = 4_096;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_ROLLBACK_BYTES = 64 * 1024 * 1024;

export class SessionCheckpointError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionCheckpointError";
    this.code = code;
  }
}

function fail(code) {
  throw new SessionCheckpointError(code);
}

function inside(root, candidate, allowRoot = false) {
  const rel = relative(root, candidate);
  if (!rel) return allowRoot;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function info(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validatedSnapshotId(value) {
  if (typeof value !== "string" || !SNAPSHOT_ID_RE.test(value) || value === "." || value === "..") {
    fail("checkpoint_id_invalid");
  }
  return value;
}

function validatedRelativePath(value, workspaceCanonical) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || isAbsolute(value)) {
    fail("checkpoint_path_invalid");
  }
  const target = resolve(workspaceCanonical, value);
  if (!inside(workspaceCanonical, target)) fail("checkpoint_path_escape");
  const normalized = relative(workspaceCanonical, target).replaceAll("\\", "/");
  if (normalized === ".kyrei/snapshots" || normalized.startsWith(".kyrei/snapshots/")) {
    fail("checkpoint_path_reserved");
  }
  return { rel: normalized, target };
}

async function assertSafeTargetParents(workspaceCanonical, target) {
  let cursor = dirname(target);
  while (inside(workspaceCanonical, cursor, true)) {
    const entry = await info(cursor);
    if (entry?.isSymbolicLink()) fail("checkpoint_target_linked");
    if (entry && !entry.isDirectory()) fail("checkpoint_target_parent_invalid");
    if (cursor === workspaceCanonical) return;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  fail("checkpoint_path_escape");
}

async function readManifest(snapshotRootCanonical, workspaceCanonical, id, budget) {
  const requestedDir = join(snapshotRootCanonical, validatedSnapshotId(id));
  const directoryInfo = await info(requestedDir);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) fail("checkpoint_not_found");
  const snapshotCanonical = await realpath(requestedDir);
  if (!inside(snapshotRootCanonical, snapshotCanonical)) fail("checkpoint_path_escape");
  const manifestPath = join(snapshotCanonical, "manifest.json");
  const manifestInfo = await info(manifestPath);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) fail("checkpoint_manifest_invalid");
  if (manifestInfo.size > MAX_MANIFEST_BYTES) fail("checkpoint_manifest_too_large");
  const manifestBytes = await readFile(manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("checkpoint_manifest_invalid");
  }
  if (
    !parsed
    || parsed.id !== id
    || parsed.workspace !== workspaceCanonical
    || !Array.isArray(parsed.files)
    || parsed.files.length > MAX_FILES
  ) {
    fail("checkpoint_manifest_invalid");
  }
  const files = [];
  for (const row of parsed.files) {
    budget.files += 1;
    if (budget.files > MAX_TOTAL_FILES) fail("checkpoint_sequence_too_large");
    if (!row || typeof row !== "object" || typeof row.existed !== "boolean") fail("checkpoint_manifest_invalid");
    const validated = validatedRelativePath(row.rel, workspaceCanonical);
    const source = join(snapshotCanonical, "files", validated.rel);
    let bytes = null;
    if (row.existed) {
      const sourceInfo = await info(source);
      if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) fail("checkpoint_payload_invalid");
      budget.bytes += sourceInfo.size;
      if (budget.bytes > MAX_ROLLBACK_BYTES) fail("checkpoint_payload_too_large");
      const sourceCanonical = await realpath(source);
      const filesRoot = resolve(snapshotCanonical, "files");
      if (!inside(filesRoot, sourceCanonical)) fail("checkpoint_payload_invalid");
      bytes = await readFile(sourceCanonical);
    }
    files.push({ ...validated, existed: row.existed, bytes });
  }
  return { id, files };
}

async function captureCurrent(files) {
  const captured = new Map();
  let bytes = 0;
  for (const file of files) {
    if (captured.has(file.target)) continue;
    await assertSafeTargetParents(file.workspaceCanonical, file.target);
    const current = await info(file.target);
    if (current?.isSymbolicLink()) fail("checkpoint_target_linked");
    if (current && !current.isFile()) fail("checkpoint_target_invalid");
    bytes += current?.size ?? 0;
    if (bytes > MAX_ROLLBACK_BYTES) fail("checkpoint_rollback_too_large");
    const content = current ? await readFile(file.target) : null;
    captured.set(file.target, content);
  }
  return captured;
}

async function writeState(target, content) {
  if (content === null) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.kyrei-restore-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Restore automatic edit snapshots in newest-to-oldest order. All manifests
 * are validated before the first write and current file contents are retained
 * in memory so a mid-sequence failure can be rolled back best-effort.
 */
export async function beginSnapshotRestore({ workspace, snapshotIds }) {
  if (!Array.isArray(snapshotIds) || snapshotIds.length > MAX_SNAPSHOTS) fail("checkpoint_sequence_invalid");
  if (snapshotIds.length === 0) {
    return {
      result: { restoredSnapshots: 0, restoredFiles: 0 },
      commit() {},
      async rollback() { return false; },
    };
  }
  const workspaceInfo = await info(workspace);
  if (!workspaceInfo?.isDirectory()) fail("checkpoint_workspace_invalid");
  const workspaceCanonical = await realpath(workspace);
  const snapshotRoot = join(workspaceCanonical, ".kyrei", "snapshots");
  const rootInfo = await info(snapshotRoot);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail("checkpoint_store_unavailable");
  const snapshotRootCanonical = await realpath(snapshotRoot);
  if (!inside(workspaceCanonical, snapshotRootCanonical)) fail("checkpoint_store_invalid");

  const manifests = [];
  const budget = { files: 0, bytes: 0 };
  for (const id of snapshotIds) {
    manifests.push(await readManifest(snapshotRootCanonical, workspaceCanonical, id, budget));
  }
  const files = manifests.flatMap(manifest => manifest.files.map(file => ({ ...file, workspaceCanonical })));
  const captured = await captureCurrent(files);

  try {
    for (const manifest of manifests) {
      for (const file of manifest.files) {
        await assertSafeTargetParents(workspaceCanonical, file.target);
        await writeState(file.target, file.existed ? file.bytes : null);
      }
    }
  } catch (error) {
    for (const [target, content] of captured) {
      await writeState(target, content).catch(() => undefined);
    }
    throw error;
  }
  let open = true;
  return {
    result: {
      restoredSnapshots: manifests.length,
      restoredFiles: new Set(files.map(file => file.target)).size,
    },
    commit() {
      open = false;
    },
    async rollback() {
      if (!open) return false;
      open = false;
      for (const [target, content] of captured) {
        await writeState(target, content);
      }
      return true;
    },
  };
}

/**
 * Convenience API for callers that do not need to coordinate the file restore
 * with another durable state change.
 */
export async function restoreSnapshotSequence(options) {
  const transaction = await beginSnapshotRestore(options);
  transaction.commit();
  return transaction.result;
}
