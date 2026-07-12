/**
 * CCR (Content-addressable Compaction Recall). Reversible compression: any
 * pruned/truncated fragment is retrievable by hash. Requirements §5.4, Property 6.
 *
 * Phase 4: disk-backed, sharded, gzip. Metadata is inferred from the on-disk
 * files (hash = filename), so it survives restarts without a separate DB.
 */

import { mkdir, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { z } from "zod";
import { tool } from "ai";
import type { ToolResult } from "../types.js";

export function ccrHash(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

export interface CcrGcPolicy {
  maxTotalBytes?: number;
  maxAgeDays?: number;
}

export interface CcrStore {
  put(content: string): Promise<string>;
  get(hash: string): Promise<string | null>;
  has(hash: string): Promise<boolean>;
  gc(policy?: CcrGcPolicy): Promise<{ removed: number; freedBytes: number }>;
}

function shardPath(baseDir: string, hash: string): { dir: string; file: string } {
  const hex = hash.slice("sha256:".length);
  const dir = join(baseDir, hex.slice(0, 2));
  return { dir, file: join(dir, `${hex}.gz`) };
}

export function createCcrStore(baseDir: string): CcrStore {
  async function put(content: string): Promise<string> {
    const hash = ccrHash(content);
    const { dir, file } = shardPath(baseDir, hash);
    await mkdir(dir, { recursive: true });
    try {
      await stat(file); // dedup: already stored
    } catch {
      await writeFile(file, gzipSync(Buffer.from(content, "utf8")));
    }
    return hash;
  }

  async function get(hash: string): Promise<string | null> {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) return null;
    const { file } = shardPath(baseDir, hash);
    try {
      const buf = await readFile(file);
      return gunzipSync(buf).toString("utf8");
    } catch {
      return null;
    }
  }

  async function has(hash: string): Promise<boolean> {
    const { file } = shardPath(baseDir, hash);
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  async function gc(policy: CcrGcPolicy = {}): Promise<{ removed: number; freedBytes: number }> {
    const maxTotal = policy.maxTotalBytes ?? 256 * 1024 * 1024;
    const maxAgeMs = (policy.maxAgeDays ?? 30) * 86_400_000;
    let shards: string[];
    try {
      shards = await readdir(baseDir);
    } catch {
      return { removed: 0, freedBytes: 0 };
    }
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    for (const sh of shards) {
      let names: string[];
      try {
        names = await readdir(join(baseDir, sh));
      } catch {
        continue;
      }
      for (const n of names) {
        const p = join(baseDir, sh, n);
        try {
          const s = await stat(p);
          if (s.isFile()) files.push({ path: p, size: s.size, mtime: s.mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    let total = 0;
    let removed = 0;
    let freedBytes = 0;
    for (const f of files) {
      total += f.size;
      const tooOld = now - f.mtime > maxAgeMs;
      const overCap = total > maxTotal;
      if (tooOld || overCap) {
        await rm(f.path, { force: true }).catch(() => {});
        removed++;
        freedBytes += f.size;
      }
    }
    return { removed, freedBytes };
  }

  return { put, get, has, gc };
}

/** Tool the model can call to expand a previously truncated fragment. */
export function makeRetrieveTool(store: CcrStore) {
  return tool({
    description:
      "Восстановить полное содержимое ранее усечённого/сжатого фрагмента по его CCR-хешу " +
      '(из маркера вида [retrievable via retrieve("sha256:...")]).',
    inputSchema: z.object({ hash: z.string() }),
    execute: async ({ hash }): Promise<ToolResult> => {
      const body = await store.get(hash);
      if (body == null) return { title: "retrieve", output: `CCR miss: ${hash} (возможно, собран GC).` };
      return { title: "retrieve", output: body, metadata: { hash, restored: true } };
    },
  });
}
