import { normalizeRelevance, type MemoryStore, type MemoryDoc } from "../ports.js";
import type { PgPool } from "./pool.js";

interface DocRow {
  id: string;
  scope: string;
  kind: string;
  path: string;
  workspace: string | null;
  title: string | null;
  body: string;
  frontmatter_json: unknown;
  content_hash: string;
  source_ref: string | null;
  updated_at: Date;
}

function toDoc(r: DocRow): MemoryDoc {
  return {
    id: r.id,
    scope: r.scope as MemoryDoc["scope"],
    kind: r.kind as MemoryDoc["kind"],
    path: r.path,
    workspace: r.workspace ?? undefined,
    title: r.title ?? undefined,
    body: r.body,
    frontmatter: r.frontmatter_json as Record<string, unknown> | undefined,
    contentHash: r.content_hash,
    sourceRef: r.source_ref ?? undefined,
    updatedAt: r.updated_at.toISOString(),
  };
}

export function createPostgresMemoryStore(pool: PgPool): MemoryStore {
  return {
    async upsertDoc(doc) {
      await pool.query(
        `INSERT INTO memory_docs(id,scope,kind,path,workspace,title,body,frontmatter_json,content_hash,source_ref,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(id) DO UPDATE SET
           scope=EXCLUDED.scope,
           kind=EXCLUDED.kind,
           path=EXCLUDED.path,
           workspace=EXCLUDED.workspace,
           title=EXCLUDED.title,
           body=EXCLUDED.body,
           frontmatter_json=EXCLUDED.frontmatter_json,
           content_hash=EXCLUDED.content_hash,
           source_ref=EXCLUDED.source_ref,
           updated_at=EXCLUDED.updated_at`,
        [
          doc.id,
          doc.scope,
          doc.kind,
          doc.path,
          doc.workspace ?? null,
          doc.title ?? null,
          doc.body,
          doc.frontmatter ? JSON.stringify(doc.frontmatter) : null,
          doc.contentHash,
          doc.sourceRef ?? null,
          doc.updatedAt,
        ]
      );
    },

    async getDoc(id) {
      const res = await pool.query<DocRow>(
        "SELECT * FROM memory_docs WHERE id=$1",
        [id]
      );
      return res.rows[0] ? toDoc(res.rows[0]) : null;
    },

    async listDocs(opts) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (opts.scope) {
        clauses.push(`scope=$${idx++}`);
        params.push(opts.scope);
      }
      if (opts.kind) {
        clauses.push(`kind=$${idx++}`);
        params.push(opts.kind);
      }
      if (opts.workspace) {
        clauses.push(`workspace=$${idx++}`);
        params.push(opts.workspace);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const res = await pool.query<DocRow>(
        `SELECT * FROM memory_docs ${where} ORDER BY updated_at DESC`,
        params
      );
      return res.rows.map(toDoc);
    },

    async search(query, opts) {
      const limit = opts?.limit ?? 20;
      // Mirrors the SQLite backend: without ts_rank the LIMIT picked arbitrary
      // matching rows rather than the best ones.
      const vector = `to_tsvector('english', COALESCE(title, '') || ' ' || body)`;
      // plainto_tsquery ANDs its terms. For "any" build an OR tsquery from
      // sanitized terms instead (to_tsquery parses operators, so anything that
      // is not a word character is stripped before it gets there).
      const anyTerms = query
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length >= 2)
        .slice(0, 24);
      const useAny = opts?.match === "any" && anyTerms.length > 0;
      const tsquery = useAny ? `to_tsquery('english', $Q)` : `plainto_tsquery('english', $Q)`;
      const queryParam = useAny ? anyTerms.join(" | ") : query;
      let sql: string;
      let params: unknown[];
      if (opts?.scope) {
        const q = tsquery.replace(/\$Q/g, "$2");
        sql = `SELECT *, ts_rank(${vector}, ${q}) AS ts_rank_score FROM memory_docs`
          + ` WHERE scope=$1 AND ${vector} @@ ${q} ORDER BY ts_rank_score DESC LIMIT $3`;
        params = [opts.scope, queryParam, limit];
      } else {
        const q = tsquery.replace(/\$Q/g, "$1");
        sql = `SELECT *, ts_rank(${vector}, ${q}) AS ts_rank_score FROM memory_docs`
          + ` WHERE ${vector} @@ ${q} ORDER BY ts_rank_score DESC LIMIT $2`;
        params = [queryParam, limit];
      }
      const res = await pool.query<DocRow & { ts_rank_score: number }>(sql, params);
      return normalizeRelevance(res.rows, (r) => Number(r.ts_rank_score)).map((r) => ({
        ...toDoc(r),
        relevance: r.relevance,
      }));
    },

    async removeDoc(id) {
      await pool.query("DELETE FROM memory_docs WHERE id=$1", [id]);
    },
  };
}
