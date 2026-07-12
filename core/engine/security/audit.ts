/**
 * Audit log (Requirements §8.5). Append-only JSONL, stored OUTSIDE the workspace
 * jail (in userData), with secret redaction. Never logs secret values.
 */

import { mkdir, appendFile, readFile, stat, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { redact } from "./secrets.js";

export interface AuditRecord {
  ts: string;
  sessionId?: string;
  tool: string;
  args?: unknown;
  decision?: string;
  status: "start" | "complete" | "error" | "denied";
  durationS?: number;
  error?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

export function createAuditLog(logPath: string) {
  async function rotateIfNeeded(): Promise<void> {
    try {
      const s = await stat(logPath);
      if (s.size > MAX_BYTES) await rename(logPath, `${logPath}.${Date.now()}.bak`);
    } catch {
      /* first write */
    }
  }

  async function write(rec: AuditRecord): Promise<void> {
    await mkdir(dirname(logPath), { recursive: true });
    await rotateIfNeeded();
    const safe: AuditRecord = {
      ...rec,
      args: rec.args !== undefined ? JSON.parse(redact(JSON.stringify(rec.args))) : undefined,
      error: rec.error ? redact(rec.error) : undefined,
    };
    await appendFile(logPath, JSON.stringify(safe) + "\n", "utf8");
  }

  async function read(limit = 200): Promise<AuditRecord[]> {
    try {
      const raw = await readFile(logPath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((l) => JSON.parse(l) as AuditRecord);
    } catch {
      return [];
    }
  }

  return { write, read };
}
