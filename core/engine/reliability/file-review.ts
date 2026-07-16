/**
 * Collect file-modifying tool outcomes for supervised execution mode
 * (Kiro Supervised analogue). Snapshot ids enable reject → restore.
 * Per-file status supports accept/reject one file at a time.
 */

import type { FileReviewFile, FileReviewState, MessagePart } from "../types.js";
import { parsePatch } from "../apply/parse-patch.js";
import { parseLineDiffHunks } from "../../diff-hunks.js";

const FILE_MUTATING_TOOLS = new Set(["write_file", "edit_file"]);

function pathsFromToolArgs(name: string, args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string" && a.path.trim()) return [a.path.trim()];
  if (typeof a.file === "string" && a.file.trim()) return [a.file.trim()];
  if (name === "edit_file" && typeof a.patch === "string") {
    try {
      return parsePatch(a.patch).map((p) => p.file).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Build a pending file-review payload from assistant parts produced this turn.
 * Returns null when no successful file-mutating tools ran.
 */
export function collectFileReviewFromParts(parts: readonly MessagePart[]): FileReviewState | null {
  const files: FileReviewFile[] = [];
  const snapshotIds: string[] = [];
  const seenSnap = new Set<string>();
  const seenPath = new Set<string>();

  for (const part of parts) {
    if (part.type !== "tool") continue;
    if (!FILE_MUTATING_TOOLS.has(part.name)) continue;
    if (part.error) continue;
    const snapshotId = typeof part.snapshotId === "string" && part.snapshotId
      ? part.snapshotId
      : undefined;
    const paths = pathsFromToolArgs(part.name, part.args);
    const list = paths.length ? paths : [part.name];
    const diffPreview = typeof part.inlineDiff === "string" && part.inlineDiff.trim()
      ? part.inlineDiff.slice(0, 8_000)
      : undefined;
    const parsed = diffPreview ? parseLineDiffHunks(diffPreview) : null;
    for (const path of list) {
      const key = `${part.name}:${path}:${snapshotId ?? ""}`;
      if (seenPath.has(key)) continue;
      seenPath.add(key);
      files.push({
        path,
        tool: part.name,
        status: "pending",
        ...(snapshotId ? { snapshotId } : {}),
        ...(diffPreview ? { diffPreview } : {}),
        ...(parsed && parsed.hunks.length
          ? {
              diffOps: parsed.ops,
              hunks: parsed.hunks.map((h) => ({
                id: h.id,
                status: "pending" as const,
                start: h.start,
                end: h.end,
                preview: h.preview,
              })),
            }
          : {}),
      });
    }
    if (snapshotId && !seenSnap.has(snapshotId)) {
      seenSnap.add(snapshotId);
      snapshotIds.push(snapshotId);
    }
  }

  if (files.length === 0) return null;
  return {
    status: "pending",
    files,
    snapshotIds,
  };
}

/** Statuses that can be upgraded to awaiting_file_review in supervised mode. */
export function canEnterFileReview(status: string): boolean {
  return status === "complete"
    || status === "max_steps"
    || status === "goal_unsatisfied"
    || status === "heal_handoff"
    || status === "budget_exceeded";
}

/** Aggregate review status from per-file decisions. */
export function aggregateFileReviewStatus(
  files: readonly FileReviewFile[],
): FileReviewState["status"] {
  if (!files.length) return "accepted";
  const pending = files.some((f) => f.status === "pending");
  if (pending) return "pending";
  const accepted = files.every((f) => f.status === "accepted");
  if (accepted) return "accepted";
  const rejected = files.every((f) => f.status === "rejected");
  if (rejected) return "rejected";
  return "partial";
}

/**
 * Apply accept/reject decisions to a review.
 * When rejecting a file, all files sharing the same snapshotId are rejected
 * (multi-file edit_file shares one pre-edit snapshot).
 */
function stampHunkStatuses(
  file: FileReviewFile,
  nextStatus: "accepted" | "rejected",
): FileReviewFile {
  if (!file.hunks?.length) return file;
  const hStatus = nextStatus === "accepted" ? "accepted" : "rejected";
  return {
    ...file,
    hunks: file.hunks.map((h) => (h.status === "pending" ? { ...h, status: hStatus } : { ...h })),
  };
}

export function applyFileReviewDecisions(
  review: FileReviewState,
  decisions: ReadonlyArray<{ path: string; accept: boolean }>,
): FileReviewState {
  const byPath = new Map(decisions.map((d) => [d.path.replaceAll("\\", "/"), d.accept]));
  const files = review.files.map((f) => ({ ...f }));
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (f.status !== "pending") continue;
    const key = f.path.replaceAll("\\", "/");
    if (!byPath.has(key)) continue;
    const accept = byPath.get(key)!;
    const nextStatus = accept ? "accepted" : "rejected";
    files[i] = stampHunkStatuses({ ...f, status: nextStatus }, nextStatus);
    // Linked snapshot: reject/accept siblings that still pending
    if (f.snapshotId) {
      for (let j = 0; j < files.length; j++) {
        const g = files[j]!;
        if (g.snapshotId === f.snapshotId && g.status === "pending") {
          files[j] = stampHunkStatuses({ ...g, status: nextStatus }, nextStatus);
        }
      }
    }
  }
  return {
    ...review,
    files,
    status: aggregateFileReviewStatus(files),
    ...(aggregateFileReviewStatus(files) !== "pending"
      ? { resolvedAt: new Date().toISOString() }
      : {}),
  };
}

/** Snapshot ids that must be restored for currently rejected files (unique). */
export function snapshotIdsForRejected(files: readonly FileReviewFile[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.status !== "rejected") continue;
    if (!f.snapshotId || seen.has(f.snapshotId)) continue;
    seen.add(f.snapshotId);
    ids.push(f.snapshotId);
  }
  return ids;
}

/**
 * Collect session-wide file mutations from chat history for View all / Revert all.
 */
export function collectSessionFileChanges(
  messages: ReadonlyArray<{
    id?: string;
    role?: string;
    parts?: readonly MessagePart[];
    at?: string;
  }>,
): Array<{
  messageId: string;
  path: string;
  tool: string;
  snapshotId?: string;
  at?: string;
  diffPreview?: string;
}> {
  const out: Array<{
    messageId: string;
    path: string;
    tool: string;
    snapshotId?: string;
    at?: string;
    diffPreview?: string;
  }> = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) continue;
    const mid = typeof message.id === "string" ? message.id : "";
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      if (!FILE_MUTATING_TOOLS.has(part.name)) continue;
      if (part.error) continue;
      const paths = pathsFromToolArgs(part.name, part.args);
      const list = paths.length ? paths : [];
      for (const path of list) {
        out.push({
          messageId: mid,
          path,
          tool: part.name,
          ...(part.snapshotId ? { snapshotId: part.snapshotId } : {}),
          ...(message.at ? { at: message.at } : {}),
          ...(typeof part.inlineDiff === "string" && part.inlineDiff
            ? { diffPreview: part.inlineDiff.slice(0, 4_000) }
            : {}),
        });
      }
    }
  }
  return out;
}
