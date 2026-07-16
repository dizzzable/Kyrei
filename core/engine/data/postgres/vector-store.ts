/**
 * VectorStore for Postgres: uses pgvector when available, falls back to
 * brute-force cosine (same as SQLite default). Requirements §10.
 */

import type { VectorStore, VectorHit } from "../ports.js";
import type { PgPool } from "./pool.js";

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
  embedding: number[] | Buffer;
}

function toFloat32Array(raw: number[] | Buffer): Float32Array {
  if (Array.isArray(raw)) return new Float32Array(raw);
  // pgvector returns binary format (little-endian float32)
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

export function createPostgresVectorStore(pool: PgPool, vecOk: boolean): VectorStore {
  return {
    async upsert(rows) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const r of rows) {
          const embeddingValue = vecOk
            ? `[${Array.from(r.embedding).join(",")}]`
            : JSON.stringify(Array.from(r.embedding));
          await client.query(
            `INSERT INTO vectors(owner_type,owner_id,chunk_index,model,dim,embedding,content_hash,created_at)
             VALUES ($1,$2,$3,$4,$5,${vecOk ? "$6::vector" : "$6"},$7,$8)
             ON CONFLICT(owner_type,owner_id,chunk_index,model) DO UPDATE SET
               dim=EXCLUDED.dim,
               embedding=EXCLUDED.embedding,
               content_hash=EXCLUDED.content_hash,
               created_at=EXCLUDED.created_at`,
            [
              r.ownerType,
              r.ownerId,
              r.chunkIndex,
              r.model,
              r.embedding.length,
              embeddingValue,
              r.contentHash,
              new Date().toISOString(),
            ]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async query(embedding, opts) {
      if (vecOk) {
        // Use pgvector's <=> operator for cosine distance
        const embStr = `[${Array.from(embedding).join(",")}]`;
        const sql = opts.ownerType
          ? `SELECT owner_type,owner_id,chunk_index,embedding <=> $1::vector AS distance
             FROM vectors WHERE owner_type=$2 ORDER BY distance LIMIT $3`
          : `SELECT owner_type,owner_id,chunk_index,embedding <=> $1::vector AS distance
             FROM vectors ORDER BY distance LIMIT $2`;
        const params = opts.ownerType ? [embStr, opts.ownerType, opts.k] : [embStr, opts.k];
        const res = await pool.query<{
          owner_type: string;
          owner_id: string;
          chunk_index: number;
          distance: number;
        }>(sql, params);
        return res.rows.map((r) => ({
          ownerType: r.owner_type,
          ownerId: r.owner_id,
          chunkIndex: r.chunk_index,
          distance: r.distance,
        }));
      } else {
        // Fallback: brute-force cosine in JS
        const sql = opts.ownerType
          ? "SELECT owner_type,owner_id,chunk_index,embedding FROM vectors WHERE owner_type=$1"
          : "SELECT owner_type,owner_id,chunk_index,embedding FROM vectors";
        const params = opts.ownerType ? [opts.ownerType] : [];
        const res = await pool.query<VecRow>(sql, params);
        const scored: VectorHit[] = res.rows.map((r) => ({
          ownerType: r.owner_type,
          ownerId: r.owner_id,
          chunkIndex: r.chunk_index,
          distance: 1 - cosine(embedding, toFloat32Array(r.embedding)),
        }));
        scored.sort((a, b) => a.distance - b.distance);
        return scored.slice(0, opts.k);
      }
    },

    async deleteByOwner(ownerType, ownerId) {
      await pool.query("DELETE FROM vectors WHERE owner_type=$1 AND owner_id=$2", [
        ownerType,
        ownerId,
      ]);
    },

    async hybridSearch(query, opts) {
      // Vector-only for now (same as SQLite)
      return this.query(query.embedding, { k: opts.k });
    },
  };
}
