/**
 * Data-layer factory. Default backend: SQLite (better-sqlite3 + FTS5, sqlite-vec
 * when loadable). If the native module fails to load (e.g. missing prebuilt),
 * degrades gracefully to a file-based session store + in-memory memory/vector.
 * Postgres backend available via async factory (Requirements §10.4).
 * Requirements §10.3.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore, MemoryStore, VectorStore, MemoryDoc, VectorHit } from "./ports.js";
import { createFileSessionStore } from "./file/session-store.js";
import { openDb } from "./sqlite/open.js";
import { createSqliteSessionStore } from "./sqlite/session-store.js";
import { createSqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteVectorStore } from "./sqlite/vector-store.js";

function isTransientSqliteOpenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|EAGAIN|EBUSY/i.test(message);
}

let sqliteFallbackWarned = false;

function warnSqliteFallback(error: unknown): void {
  if (sqliteFallbackWarned) return;
  sqliteFallbackWarned = true;
  console.warn(
    "[kyrei data] SQLite unavailable, using file backend:",
    error instanceof Error ? error.message : String(error),
  );
}

function openSqliteStores(baseDir: string): Stores {
  const { db, vecOk } = openDb(join(baseDir, "index.db"));
  return {
    backend: "sqlite",
    vectorSearch: vecOk ? "sqlite-vec" : "bruteforce",
    sessions: createSqliteSessionStore(db),
    memory: createSqliteMemoryStore(db),
    vectors: createSqliteVectorStore(db),
    close: () => { db.close(); },
  };
}

/** Prefer SQLite; retry transient locks before falling back to durable file store. */
function openSqliteStoresWithRetry(baseDir: string, attempts = 4): Stores {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return openSqliteStores(baseDir);
    } catch (error) {
      lastError = error;
      if (!isTransientSqliteOpenError(error) || attempt === attempts - 1) break;
      // brief backoff for concurrent chat-turn + Settings reindex
      const waitMs = 25 * (attempt + 1);
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        /* spin short — sync API */
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface Stores {
  backend: "sqlite" | "postgres" | "file";
  vectorSearch: "sqlite-vec" | "pgvector" | "bruteforce";
  sessions: SessionStore;
  memory: MemoryStore;
  vectors: VectorStore;
  close(): void | Promise<void>;
}

export function createStores(baseDir: string): Stores {
  try {
    // better-sqlite3 is external and only executes native code here (openDb → new Database).
    return openSqliteStoresWithRetry(baseDir);
  } catch (err) {
    warnSqliteFallback(err);
    return createFileStores(baseDir);
  }
}

/**
 * Degraded fallback when native SQLite is unavailable.
 * Memory docs persist under baseDir so reindex results survive process restarts
 * (the old in-memory Map looked successful then vanished on next status check).
 */
export function createFileStores(baseDir: string): Stores {
  const sessions = createFileSessionStore(baseDir);
  const docsPath = join(baseDir, "memory-docs.json");
  const vectorsPath = join(baseDir, "memory-vectors.json");
  const docs = new Map<string, MemoryDoc>();
  const vecRows: Array<{
    ownerType: string;
    ownerId: string;
    chunkIndex: number;
    model?: string;
    contentHash?: string;
    embedding: Float32Array;
  }> = [];

  try {
    mkdirSync(baseDir, { recursive: true });
  } catch {
    /* best effort */
  }

  try {
    if (existsSync(docsPath)) {
      const parsed = JSON.parse(readFileSync(docsPath, "utf8")) as MemoryDoc[];
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (d && typeof d.id === "string") docs.set(d.id, d);
        }
      }
    }
  } catch {
    /* corrupt file — start empty */
  }

  try {
    if (existsSync(vectorsPath)) {
      const parsed = JSON.parse(readFileSync(vectorsPath, "utf8")) as Array<{
        ownerType: string;
        ownerId: string;
        chunkIndex: number;
        model?: string;
        contentHash?: string;
        embedding: number[];
      }>;
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (!r?.ownerType || !r?.ownerId || !Array.isArray(r.embedding)) continue;
          vecRows.push({
            ownerType: r.ownerType,
            ownerId: r.ownerId,
            chunkIndex: Number(r.chunkIndex) || 0,
            ...(r.model ? { model: r.model } : {}),
            ...(r.contentHash ? { contentHash: r.contentHash } : {}),
            embedding: Float32Array.from(r.embedding),
          });
        }
      }
    }
  } catch {
    /* ignore */
  }

  const flushDocs = (): void => {
    try {
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(docsPath, `${JSON.stringify([...docs.values()], null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn("[kyrei data] file memory flush failed:", (error as Error).message);
    }
  };

  const flushVectors = (): void => {
    try {
      mkdirSync(baseDir, { recursive: true });
      const serializable = vecRows.map((r) => ({
        ownerType: r.ownerType,
        ownerId: r.ownerId,
        chunkIndex: r.chunkIndex,
        ...(r.model ? { model: r.model } : {}),
        ...(r.contentHash ? { contentHash: r.contentHash } : {}),
        embedding: [...r.embedding],
      }));
      writeFileSync(vectorsPath, `${JSON.stringify(serializable)}\n`, "utf8");
    } catch (error) {
      console.warn("[kyrei data] file vector flush failed:", (error as Error).message);
    }
  };

  const memory: MemoryStore = {
    async upsertDoc(d) {
      docs.set(d.id, d);
      flushDocs();
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
      flushDocs();
    },
  };
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
        const row = {
          ownerType: r.ownerType,
          ownerId: r.ownerId,
          chunkIndex: r.chunkIndex,
          ...(r.model ? { model: r.model } : {}),
          ...(r.contentHash ? { contentHash: r.contentHash } : {}),
          embedding: r.embedding,
        };
        if (i >= 0) vecRows[i] = row;
        else vecRows.push(row);
      }
      flushVectors();
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
      flushVectors();
    },
    async hybridSearch(query, opts) {
      return this.query(query.embedding, { k: opts.k });
    },
  };
  return { backend: "file", vectorSearch: "bruteforce", sessions, memory, vectors, close: () => {} };
}

/** Postgres backend (async, requires DATABASE_URL or explicit connection string). */
export async function createPostgresStores(connectionString: string): Promise<Stores> {
  const { openPool } = await import("./postgres/pool.js");
  const { createPostgresSessionStore } = await import("./postgres/session-store.js");
  const { createPostgresMemoryStore } = await import("./postgres/memory-store.js");
  const { createPostgresVectorStore } = await import("./postgres/vector-store.js");

  const { pool, vecOk } = await openPool(connectionString);
  return {
    backend: "postgres",
    vectorSearch: vecOk ? "pgvector" : "bruteforce",
    sessions: createPostgresSessionStore(pool),
    memory: createPostgresMemoryStore(pool),
    vectors: createPostgresVectorStore(pool, vecOk),
    close: async () => pool.end(),
  };
}

/**
 * Async factory with backend selection. Chooses SQLite (default), Postgres (if
 * connectionString provided), or degrades to file backend on SQLite failure.
 */
export async function createStoresAsync(opts: {
  baseDir: string;
  backend?: "sqlite" | "postgres";
  connectionString?: string;
}): Promise<Stores> {
  if (opts.backend === "postgres") {
    if (!opts.connectionString) throw new Error("Postgres backend requires connectionString");
    return createPostgresStores(opts.connectionString);
  }
  // Default: try SQLite (with lock retries), fallback to durable file store
  try {
    return openSqliteStoresWithRetry(opts.baseDir);
  } catch (err) {
    warnSqliteFallback(err);
    return createFileStores(opts.baseDir);
  }
}
