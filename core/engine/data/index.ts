/**
 * Data-layer factory. Default backend: SQLite (better-sqlite3 + FTS5, sqlite-vec
 * when loadable). If the native module fails to load (e.g. missing prebuilt),
 * degrades gracefully to a file-based session store + in-memory memory/vector.
 * Requirements §10.3.
 */

import { join } from "node:path";
import type { SessionStore, MemoryStore, VectorStore, MemoryDoc, VectorHit } from "./ports.js";
import { createFileSessionStore } from "./file/session-store.js";
import { openDb } from "./sqlite/open.js";
import { createSqliteSessionStore } from "./sqlite/session-store.js";
import { createSqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteVectorStore } from "./sqlite/vector-store.js";

export interface Stores {
  backend: "sqlite" | "file";
  vectorSearch: "sqlite-vec" | "bruteforce";
  sessions: SessionStore;
  memory: MemoryStore;
  vectors: VectorStore;
  close(): void;
}

export function createStores(baseDir: string): Stores {
  try {
    // better-sqlite3 is external and only executes native code here (openDb → new Database).
    const { db, vecOk } = openDb(join(baseDir, "index.db"));
    return {
      backend: "sqlite",
      vectorSearch: vecOk ? "sqlite-vec" : "bruteforce",
      sessions: createSqliteSessionStore(db),
      memory: createSqliteMemoryStore(db),
      vectors: createSqliteVectorStore(db),
      close: () => db.close(),
    };
  } catch (err) {
    console.warn("[kyrei data] SQLite unavailable, using file backend:", (err as Error).message);
    return createFileStores(baseDir);
  }
}

/** Degraded fallback: file session store + in-memory memory/vector. */
export function createFileStores(baseDir: string): Stores {
  const sessions = createFileSessionStore(baseDir);
  const docs = new Map<string, MemoryDoc>();
  const memory: MemoryStore = {
    async upsertDoc(d) {
      docs.set(d.id, d);
    },
    async getDoc(id) {
      return docs.get(id) ?? null;
    },
    async listDocs(opts) {
      return [...docs.values()].filter(
        (d) =>
          (!opts.scope || d.scope === opts.scope) &&
          (!opts.kind || d.kind === opts.kind) &&
          (!opts.workspace || d.workspace === opts.workspace),
      );
    },
    async search(query, opts) {
      const q = query.toLowerCase();
      return [...docs.values()]
        .filter((d) => (!opts?.scope || d.scope === opts.scope) && (d.title ?? "").concat(" ", d.body).toLowerCase().includes(q))
        .slice(0, opts?.limit ?? 20);
    },
    async removeDoc(id) {
      docs.delete(id);
    },
  };
  const vecRows: Array<{ ownerType: string; ownerId: string; chunkIndex: number; embedding: Float32Array }> = [];
  const cosine = (a: Float32Array, b: Float32Array): number => {
    const n = Math.min(a.length, b.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  };
  const vectors: VectorStore = {
    async upsert(rows) {
      for (const r of rows) {
        const i = vecRows.findIndex((x) => x.ownerType === r.ownerType && x.ownerId === r.ownerId && x.chunkIndex === r.chunkIndex);
        const row = { ownerType: r.ownerType, ownerId: r.ownerId, chunkIndex: r.chunkIndex, embedding: r.embedding };
        if (i >= 0) vecRows[i] = row;
        else vecRows.push(row);
      }
    },
    async query(embedding, opts) {
      const hits: VectorHit[] = vecRows
        .filter((r) => !opts.ownerType || r.ownerType === opts.ownerType)
        .map((r) => ({ ownerType: r.ownerType, ownerId: r.ownerId, chunkIndex: r.chunkIndex, distance: 1 - cosine(embedding, r.embedding) }));
      hits.sort((a, b) => a.distance - b.distance);
      return hits.slice(0, opts.k);
    },
    async deleteByOwner(ownerType, ownerId) {
      for (let i = vecRows.length - 1; i >= 0; i--) if (vecRows[i]!.ownerType === ownerType && vecRows[i]!.ownerId === ownerId) vecRows.splice(i, 1);
    },
    async hybridSearch(query, opts) {
      return this.query(query.embedding, { k: opts.k });
    },
  };
  return { backend: "file", vectorSearch: "bruteforce", sessions, memory, vectors, close: () => {} };
}
