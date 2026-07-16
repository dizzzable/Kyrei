/**
 * Pure file-review decision helpers for the gateway (mirrors engine/reliability/file-review).
 */

import {
  applyHunkDecisions,
  aggregateHunkStatus,
  applyHunksToOldText,
} from "./diff-hunks.js";

export function aggregateFileReviewStatus(files) {
  if (!Array.isArray(files) || files.length === 0) return "accepted";
  if (files.some((f) => f.status === "pending")) return "pending";
  if (files.every((f) => f.status === "accepted")) return "accepted";
  if (files.every((f) => f.status === "rejected")) return "rejected";
  return "partial";
}

/**
 * @param {object} review
 * @param {Array<{ path: string, accept: boolean }>} decisions
 */
function stampHunks(file, nextStatus) {
  if (!Array.isArray(file?.hunks) || !file.hunks.length) return file;
  const hStatus = nextStatus === "accepted" ? "accepted" : "rejected";
  return {
    ...file,
    hunks: file.hunks.map((h) => (h.status === "pending" ? { ...h, status: hStatus } : { ...h })),
  };
}

export function applyFileReviewDecisions(review, decisions) {
  const byPath = new Map(
    (Array.isArray(decisions) ? decisions : []).map((d) => [
      String(d.path ?? "").replaceAll("\\", "/"),
      d.accept === true,
    ]),
  );
  const files = (Array.isArray(review?.files) ? review.files : []).map((f) => ({ ...f }));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.status !== "pending") continue;
    const key = String(f.path ?? "").replaceAll("\\", "/");
    if (!byPath.has(key)) continue;
    const accept = byPath.get(key);
    const nextStatus = accept ? "accepted" : "rejected";
    files[i] = stampHunks({ ...f, status: nextStatus }, nextStatus);
    if (f.snapshotId) {
      for (let j = 0; j < files.length; j++) {
        const g = files[j];
        if (g.snapshotId === f.snapshotId && g.status === "pending") {
          files[j] = stampHunks({ ...g, status: nextStatus }, nextStatus);
        }
      }
    }
  }
  const status = aggregateFileReviewStatus(files);
  return {
    ...review,
    files,
    status,
    ...(status !== "pending" ? { resolvedAt: new Date().toISOString() } : {}),
  };
}

export function snapshotIdsForRejected(files) {
  const ids = [];
  const seen = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    if (f.status !== "rejected") continue;
    if (!f.snapshotId || seen.has(f.snapshotId)) continue;
    seen.add(f.snapshotId);
    ids.push(f.snapshotId);
  }
  return ids;
}

/**
 * Apply per-hunk decisions on a single file entry.
 * Mixed accept/reject (all hunks decided) → file status "accepted" (content selective-applied).
 * @param {object} file
 * @param {Array<{ id: string, accept: boolean }>} hunkDecisions
 */
export function applyHunkDecisionsToFile(file, hunkDecisions) {
  if (!file || !Array.isArray(file.hunks) || !file.hunks.length) return file;
  const hunks = applyHunkDecisions(file.hunks, hunkDecisions);
  return finalizeFileFromHunks({ ...file, hunks });
}

/**
 * After all hunks decided, derive final file status.
 * - pending: any hunk still open
 * - accepted: all accepted OR mixed (selective content kept)
 * - rejected: all hunks rejected (path restore)
 */
export function finalizeFileFromHunks(file) {
  if (!file?.hunks?.length) return file;
  const hunkStatus = aggregateHunkStatus(file.hunks);
  if (hunkStatus === "pending") {
    return { ...file, status: "pending", hunks: file.hunks };
  }
  if (hunkStatus === "rejected") {
    return { ...file, status: "rejected", hunks: file.hunks };
  }
  // accepted or partial (mixed) — review of this file is complete
  return { ...file, status: "accepted", hunks: file.hunks };
}

/**
 * Re-aggregate review after per-file / per-hunk mutations.
 */
export function withAggregatedReview(review, files) {
  const list = Array.isArray(files) ? files : [];
  const status = aggregateFileReviewStatus(list);
  return {
    ...review,
    files: list,
    status,
    ...(status !== "pending" ? { resolvedAt: new Date().toISOString() } : {}),
  };
}

/**
 * Whether a completed file needs selective rewrite (mixed hunk decisions).
 */
export function needsSelectiveHunkApply(file) {
  if (!file || file.status !== "accepted") return false;
  if (!Array.isArray(file.hunks) || !file.hunks.length) return false;
  if (!Array.isArray(file.diffOps) || !file.diffOps.length) return false;
  const hasRejected = file.hunks.some((h) => h.status === "rejected");
  const hasAccepted = file.hunks.some((h) => h.status === "accepted");
  return hasRejected && hasAccepted;
}

export { applyHunksToOldText, aggregateHunkStatus };

export function collectSessionFileChanges(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant" || !Array.isArray(message.parts)) continue;
    const mid = typeof message.id === "string" ? message.id : "";
    for (const part of message.parts) {
      if (part?.type !== "tool") continue;
      if (part.name !== "write_file" && part.name !== "edit_file") continue;
      if (part.error) continue;
      const path = typeof part.args?.path === "string"
        ? part.args.path
        : typeof part.args?.file === "string"
          ? part.args.file
          : "";
      if (!path) continue;
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
  return out;
}
