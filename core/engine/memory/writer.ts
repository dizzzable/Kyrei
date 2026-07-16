/**
 * Memory writer with enforced write-paths (Requirements §6.3). The main agent
 * may only write notes.md (scratch); the writer role owns the structural files.
 * All writes go through the cross-process file lock.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileLock } from "./lock.js";

export type MemoryRole = "main" | "writer";

const WRITE_PATTERNS: Record<MemoryRole, RegExp[]> = {
  main: [/[/\\]\.kyrei[/\\]memory[/\\]notes\.md$/],
  writer: [
    /[/\\]\.kyrei[/\\]memory[/\\]MEMORY\.md$/,
    /[/\\]\.kyrei[/\\]memory[/\\]notes\.md$/,
    /[/\\]\.kyrei[/\\]handoff[/\\][\w.-]+\.md$/,
    // User-global preferences under …/kyrei/memory/GLOBAL.md or …/memory/GLOBAL.md
    /[/\\](?:kyrei[/\\])?memory[/\\]GLOBAL\.md$/,
  ],
};

export function assertWritable(role: MemoryRole, absPath: string): void {
  const norm = resolve(absPath);
  const ok = WRITE_PATTERNS[role].some((re) => re.test(norm));
  if (!ok) throw new Error(`memory write denied: role=${role} path=${absPath}`);
}

export async function writeMemory(role: MemoryRole, absPath: string, content: string): Promise<void> {
  assertWritable(role, absPath);
  await mkdir(dirname(absPath), { recursive: true });
  await withFileLock(absPath, async () => {
    await writeFile(absPath, content, "utf8");
  });
}
