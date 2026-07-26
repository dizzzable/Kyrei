/**
 * Rolling context-summary artifacts for stage-B compression.
 * Stored under workspace/.kyrei/context-summary/<sessionId>.json — not chat SoT.
 */

import { mkdir, readFile, readdir, stat, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Summaries kept on disk. One file per session, and nothing deleted them — a
 * long-lived workspace accumulated one forever, plus a `.tmp` for every write
 * the process did not survive.
 *
 * Unlike apply snapshots (which deliberately have no GC because rewind buttons
 * in the durable chat history reference them by id), a summary is a derived
 * cache: dropping one costs a recompression, never a broken affordance.
 */
export const MAX_CONTEXT_SUMMARIES = 200;
/** A `.tmp` older than this cannot belong to an in-flight write. */
export const ORPHAN_TMP_MS = 60 * 60 * 1000;

export interface ContextSummaryRecord {
  sessionId: string;
  updatedAt: string;
  via: "heuristic" | "llm";
  summaryText: string;
  middleCcrHash?: string;
  sourceMessageCount: number;
  charCount: number;
}

function safeSessionFileName(sessionId: string): string {
  return String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "session";
}

export function contextSummaryDir(workspace: string): string {
  return join(workspace, ".kyrei", "context-summary");
}

export function contextSummaryPath(workspace: string, sessionId: string): string {
  return join(contextSummaryDir(workspace), `${safeSessionFileName(sessionId)}.json`);
}

export async function readContextSummary(
  workspace: string,
  sessionId: string,
): Promise<ContextSummaryRecord | null> {
  if (!workspace || !sessionId) return null;
  try {
    const raw = JSON.parse(await readFile(contextSummaryPath(workspace, sessionId), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.summaryText !== "string" || !raw.summaryText.trim()) return null;
    return {
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : sessionId,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      via: raw.via === "llm" ? "llm" : "heuristic",
      summaryText: raw.summaryText,
      ...(typeof raw.middleCcrHash === "string" ? { middleCcrHash: raw.middleCcrHash } : {}),
      sourceMessageCount: Number.isFinite(raw.sourceMessageCount) ? Number(raw.sourceMessageCount) : 0,
      charCount: Number.isFinite(raw.charCount) ? Number(raw.charCount) : raw.summaryText.length,
    };
  } catch {
    return null;
  }
}

export async function writeContextSummary(
  workspace: string,
  record: ContextSummaryRecord,
): Promise<string> {
  const dir = contextSummaryDir(workspace);
  await mkdir(dir, { recursive: true });
  const path = contextSummaryPath(workspace, record.sessionId);
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } catch (error) {
    // Do not leave the partial temp behind if the rename never happened.
    await unlink(tmp).catch(() => {});
    throw error;
  }
  // Compression is rare, so sweeping here costs one readdir per compressed
  // turn and keeps the directory bounded without a separate scheduler.
  await pruneContextSummaries(workspace, {
    protect: `${safeSessionFileName(record.sessionId)}.json`,
  }).catch(() => {});
  return path;
}

export async function clearContextSummary(workspace: string, sessionId: string): Promise<void> {
  try {
    await unlink(contextSummaryPath(workspace, sessionId));
  } catch {
    /* ignore */
  }
}

/**
 * Decide which summary files to delete.
 *
 * Pure so the policy is testable without a filesystem. Keeps the `keep` most
 * recently written summaries and always keeps `protect`, which is the file the
 * caller just wrote — its mtime may not be readable yet on every platform.
 */
export function contextSummariesToDrop(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
  options: { keep: number; protect?: string },
): string[] {
  const keep = Math.max(1, options.keep);
  const ranked = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const survivors = new Set<string>();
  if (options.protect) survivors.add(options.protect);
  for (const entry of ranked) {
    if (survivors.size >= keep && !survivors.has(entry.name)) break;
    survivors.add(entry.name);
  }
  return ranked.filter((entry) => !survivors.has(entry.name)).map((entry) => entry.name);
}

/**
 * Drop stale summaries and orphaned temp files. Best-effort: a retention sweep
 * must never fail the turn that triggered it.
 */
export async function pruneContextSummaries(
  workspace: string,
  options: { keep?: number; protect?: string; now?: number } = {},
): Promise<void> {
  const dir = contextSummaryDir(workspace);
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const summaries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      if (!info.isFile()) continue;
      // A `.tmp` still within the window may belong to a concurrent write.
      if (name.endsWith(".tmp")) {
        if (now - info.mtimeMs > ORPHAN_TMP_MS) await unlink(join(dir, name)).catch(() => {});
        continue;
      }
      if (name.endsWith(".json")) summaries.push({ name, mtimeMs: info.mtimeMs });
    } catch {
      /* raced with another writer; skip */
    }
  }
  const doomed = contextSummariesToDrop(summaries, {
    keep: options.keep ?? MAX_CONTEXT_SUMMARIES,
    ...(options.protect ? { protect: options.protect } : {}),
  });
  for (const name of doomed) await unlink(join(dir, name)).catch(() => {});
}
