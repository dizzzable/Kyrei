/**
 * VectorStore (Phase 5): brute-force cosine over embeddings stored as BLOB.
 * Correct and dependency-light; sqlite-vec vec0 KNN is a future optimization
 * (the extension is already loaded when available). Requirements §10.
 */

import type { VectorStore, VectorHit } from "../ports.js";
import type { DB } from "./open.js";

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface VecRow {
  owner_type: string;
  owner_id: string;
  chunk_index: number;
  embedding: Buffer;
}

export function createSqliteVectorStore(db: DB): VectorStore {
  return {
    async upsert(rows) {
      const stmt = db.prepare(
        `INSERT INTO vectors(owner_type,owner_id,chunk_index,model,dim,embedding,content_hash,created_at)
         VALUES (@owner_type,@owner_id,@chunk_index,@model,@dim,@embedding,@content_hash,@created_at)
         ON CONFLICT(owner_type,owner_id,chunk_index,model) DO UPDATE SET
           dim=excluded.dim, embedding=excluded.embedding, content_hash=excluded.content_hash, created_at=excluded.created_at`,
      );
      const tx = db.transaction((items: typeof rows) => {
        for (const r of items) {
          stmt.run({
            owner_type: r.ownerType,
            owner_id: r.ownerId,
            chunk_index: r.chunkIndex,
            model: r.model,
            dim: r.embedding.length,
            embedding: toBlob(r.embedding),
            content_hash: r.contentHash,
            created_at: new Date().toISOString(),
          });
        }
      });
      tx(rows);
    },

    async query(embedding, opts) {
      const rows = (
        opts.ownerType
          ? db.prepare("SELECT owner_type,owner_id,chunk_index,embedding FROM vectors WHERE owner_type=?").all(opts.ownerType)
          : db.prepare("SELECT owner_type,owner_id,chunk_index,embedding FROM vectors").all()
      ) as VecRow[];
      const scored: VectorHit[] = rows.map((r) => ({
        ownerType: r.owner_type,
        ownerId: r.owner_id,
        chunkIndex: r.chunk_index,
        distance: 1 - cosine(embedding, fromBlob(r.embedding)),
      }));
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, opts.k);
    },

    async deleteByOwner(ownerType, ownerId) {
      db.prepare("DELETE FROM vectors WHERE owner_type=? AND owner_id=?").run(ownerType, ownerId);
    },

    async hybridSearch(query, opts) {
      // Phase 5: vector-only (keyword fusion via memory/messages FTS lives in those stores).
      return this.query(query.embedding, { k: opts.k });
    },
  };
}
