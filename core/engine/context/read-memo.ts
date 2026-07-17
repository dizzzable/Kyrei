/**
 * Wave B4 — read-memo (path@hash).
 *
 * Within a single agent turn, repeated read_file of an unchanged file returns
 * a short stub instead of re-shipping the full body (Headroom-adjacent).
 * Writes/edits invalidate the memo for that path.
 */

import { createHash } from "node:crypto";

export function contentFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export interface ReadMemoEntry {
  hash: string;
  chars: number;
  reads: number;
  firstSeenAt: number;
}

export interface ReadMemo {
  /** First read returns full content; later identical reads return a stub. */
  note(path: string, content: string): { text: string; hit: boolean; hash: string };
  invalidate(path?: string): void;
  get(path: string): ReadMemoEntry | undefined;
  size(): number;
  stats(): { entries: number; hits: number; misses: number };
}

export function createReadMemo(): ReadMemo {
  const map = new Map<string, ReadMemoEntry>();
  let hits = 0;
  let misses = 0;

  return {
    note(path, content) {
      const key = normalizePath(path);
      const hash = contentFingerprint(content);
      const prev = map.get(key);
      if (prev && prev.hash === hash) {
        hits += 1;
        prev.reads += 1;
        const stub = [
          `[read-memo] ${key}@${hash} (${prev.chars} chars) already in this turn — content unchanged.`,
          `Rely on the earlier read_file result; do not re-process the full file unless you need a different slice.`,
          `If context was compacted, re-read once or use retrieve() when a CCR hash was provided.`,
        ].join("\n");
        return { text: stub, hit: true, hash };
      }
      misses += 1;
      map.set(key, {
        hash,
        chars: content.length,
        reads: 1,
        firstSeenAt: Date.now(),
      });
      return { text: content, hit: false, hash };
    },
    invalidate(path) {
      if (!path) {
        map.clear();
        return;
      }
      map.delete(normalizePath(path));
    },
    get(path) {
      return map.get(normalizePath(path));
    },
    size() {
      return map.size;
    },
    stats() {
      return { entries: map.size, hits, misses };
    },
  };
}
