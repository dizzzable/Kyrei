/**
 * Apply context-anchored patches. Requirements §3.3, §3.8–§3.15, Properties 2/9/10/11.
 *
 * Model: stage all in memory → snapshot → write all atomically → rollback on any
 * failure. Nothing is written to disk until every hunk of every file applies.
 */

import { readFile, writeFile, mkdir, rm, rename, open } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { validateWriteTarget } from "../security/jail.js";
import { detectMeta, decodeToLines, serialize, defaultNewMeta, type FileMeta } from "./file-meta.js";
import { seekSequence } from "./seek.js";
import type { FilePatch, PatchHunk } from "./parse-patch.js";
import type { SnapshotStore } from "./snapshot.js";

export type ApplyErrorCode = "NOT_FOUND" | "AMBIGUOUS" | "NOOP" | "BINARY" | "EXISTS" | "MISSING";

export class ApplyError extends Error {
  code: ApplyErrorCode;
  file: string;
  constructor(code: ApplyErrorCode, file: string, message: string) {
    super(message);
    this.code = code;
    this.file = file;
    this.name = "ApplyError";
  }
}

function seekWithAnchor(lines: string[], hunk: PatchHunk): { index: number; matches: number[] } {
  const res = seekSequence(lines, hunk.needle);
  if (res.matches.length <= 1 || !hunk.anchor) return { index: res.index, matches: res.matches };
  // Narrow by anchor: keep needle matches at/after the first anchor occurrence.
  const anchorRes = seekSequence(lines, [hunk.anchor]);
  if (anchorRes.matches.length >= 1) {
    const from = anchorRes.matches[0]!;
    const filtered = res.matches.filter((m) => m >= from);
    if (filtered.length === 1) return { index: filtered[0]!, matches: filtered };
  }
  return { index: res.index, matches: res.matches };
}

function applyHunk(lines: string[], hunk: PatchHunk, file: string): string[] {
  if (hunk.needle.length === 0) {
    throw new ApplyError("NOT_FOUND", file, "Hunk has no context lines to locate the insertion point.");
  }
  const { index, matches } = seekWithAnchor(lines, hunk);
  if (matches.length === 0) {
    throw new ApplyError(
      "NOT_FOUND",
      file,
      `Edit context not found (0 matches). File unchanged.\nLooked for:\n${hunk.needle.slice(0, 5).join("\n")}\nRe-read the file (read_file) and rewrite the context lines to match.`,
    );
  }
  if (matches.length > 1) {
    throw new ApplyError(
      "AMBIGUOUS",
      file,
      `Context matched in ${matches.length} places (lines: ${matches.map((m) => m + 1).join(", ")}) — edit rejected as ambiguous. Add more context lines, or an '@@' hint naming a unique enclosing declaration.`,
    );
  }
  const out: string[] = [];
  let cursor = index;
  for (const op of hunk.ops) {
    if (op.kind === " ") {
      out.push(lines[cursor]!); // original bytes, not normalized
      cursor++;
    } else if (op.kind === "-") {
      cursor++;
    } else {
      out.push(op.text);
    }
  }
  const consumed = cursor - index;
  return [...lines.slice(0, index), ...out, ...lines.slice(index + consumed)];
}

export interface StagedFile {
  rel: string;
  absTarget: string;
  op: FilePatch["op"];
  nextBytes?: Buffer;
  moveFrom?: string;
  oldText: string;
  newText: string;
}

export interface ApplyReport {
  snapshotId: string;
  files: Array<{ rel: string; op: FilePatch["op"]; oldText: string; newText: string }>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(target: string, data: Buffer): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.kyrei-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, target);
}

export async function applyPatch(
  workspace: string,
  patches: FilePatch[],
  snapshot: SnapshotStore,
  abortSignal?: AbortSignal,
): Promise<ApplyReport> {
  abortSignal?.throwIfAborted();
  // ── Phase 1: stage in memory (no writes). Any failure throws before disk. ──
  const staged: StagedFile[] = [];
  for (const p of patches) {
    abortSignal?.throwIfAborted();
    const absTarget = await validateWriteTarget(workspace, p.file);
    const rel = relative(workspace, absTarget) || p.file;

    if (p.op === "delete") {
      if (!(await exists(absTarget))) throw new ApplyError("MISSING", p.file, `File not found: ${rel}`);
      const oldText = (await readFile(absTarget)).toString("utf8");
      staged.push({ rel, absTarget, op: "delete", oldText, newText: "" });
      continue;
    }

    if (p.op === "add") {
      if (await exists(absTarget)) throw new ApplyError("EXISTS", p.file, `File already exists: ${rel} — use *** Update File instead`);
      const meta = defaultNewMeta();
      const body = p.addBody ?? [];
      if (body.length === 0) throw new ApplyError("NOOP", p.file, "Add File has no body (no-op).");
      staged.push({ rel, absTarget, op: "add", meta, nextBytes: serialize(body, meta), oldText: "", newText: body.join("\n") } as StagedFile);
      continue;
    }

    // update / move
    const srcAbs = absTarget;
    if (!(await exists(srcAbs))) throw new ApplyError("MISSING", p.file, `File not found: ${rel}`);
    const buf = await readFile(srcAbs);
    const meta: FileMeta = detectMeta(buf);
    if (meta.encoding === "binary") {
      throw new ApplyError("BINARY", p.file, `File is binary or not UTF-8 — edit rejected: ${rel}`);
    }
    const oldLines = decodeToLines(buf, meta);
    let cur = oldLines;
    for (const h of p.hunks) cur = applyHunk(cur, h, p.file);
    const oldText = oldLines.join("\n");
    const newText = cur.join("\n");
    if (newText === oldText && p.op === "update") throw new ApplyError("NOOP", p.file, `Edit leaves the file unchanged (no-op): ${rel}`);

    if (p.op === "move") {
      const destAbs = await validateWriteTarget(workspace, p.dest!);
      if (await exists(destAbs)) throw new ApplyError("EXISTS", p.dest!, `Move destination already exists: ${p.dest}`);
      staged.push({
        rel: relative(workspace, destAbs) || p.dest!,
        absTarget: destAbs,
        op: "move",
        moveFrom: srcAbs,
        nextBytes: serialize(cur, meta),
        oldText,
        newText,
      });
    } else {
      staged.push({ rel, absTarget: srcAbs, op: "update", nextBytes: serialize(cur, meta), oldText, newText });
    }
  }

  // ── Phase 2: snapshot before any write. ──
  abortSignal?.throwIfAborted();
  const affected = new Set<string>();
  for (const s of staged) {
    await validateWriteTarget(workspace, relative(workspace, s.absTarget));
    if (s.moveFrom) await validateWriteTarget(workspace, relative(workspace, s.moveFrom));
    affected.add(relative(workspace, s.absTarget) || s.rel);
    if (s.moveFrom) affected.add(relative(workspace, s.moveFrom));
  }
  const snapshotId = await snapshot.create([...affected]);

  // ── Phase 3: write all, with inline undo journal for best-effort rollback. ──
  abortSignal?.throwIfAborted();
  const undo: Array<() => Promise<void>> = [];
  try {
    for (const s of staged) {
      abortSignal?.throwIfAborted();
      await validateWriteTarget(workspace, relative(workspace, s.absTarget));
      if (s.moveFrom) await validateWriteTarget(workspace, relative(workspace, s.moveFrom));
      if (s.op === "delete") {
        const prev = await readFile(s.absTarget);
        await rm(s.absTarget, { force: true });
        undo.push(async () => {
          await atomicWrite(s.absTarget, prev);
        });
      } else if (s.op === "move") {
        await atomicWrite(s.absTarget, s.nextBytes!);
        const prevSrc = await readFile(s.moveFrom!);
        await rm(s.moveFrom!, { force: true });
        undo.push(async () => {
          await atomicWrite(s.moveFrom!, prevSrc);
          await rm(s.absTarget, { force: true });
        });
      } else {
        const existed = await exists(s.absTarget);
        const prev = existed ? await readFile(s.absTarget) : null;
        await atomicWrite(s.absTarget, s.nextBytes!);
        undo.push(async () => {
          if (prev) await atomicWrite(s.absTarget, prev);
          else await rm(s.absTarget, { force: true });
        });
      }
    }
  } catch (err) {
    for (const u of undo.reverse()) await u().catch(() => {});
    await snapshot.restore(snapshotId).catch(() => {});
    throw err;
  }

  return {
    snapshotId,
    files: staged.map((s) => ({ rel: s.rel, op: s.op, oldText: s.oldText, newText: s.newText })),
  };
}
