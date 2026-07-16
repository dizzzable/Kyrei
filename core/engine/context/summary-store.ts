/**
 * Rolling context-summary artifacts for stage-B compression.
 * Stored under workspace/.kyrei/context-summary/<sessionId>.json — not chat SoT.
 */

import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
  return path;
}

export async function clearContextSummary(workspace: string, sessionId: string): Promise<void> {
  try {
    await unlink(contextSummaryPath(workspace, sessionId));
  } catch {
    /* ignore */
  }
}
