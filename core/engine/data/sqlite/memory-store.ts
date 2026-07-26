import { normalizeRelevance, type MemoryStore, type MemoryDoc } from "../ports.js";
import type { DB } from "./open.js";

function ftsQuery(q: string, match: "all" | "any" = "all"): string {
  // FTS5: a double-quoted string is a PHRASE query (tokens must be adjacent in
  // order), so wrapping the whole query in one pair of quotes silently returns
  // zero rows for any multi-word natural-language search. Tokenize instead and
  // quote each term individually — FTS5 ANDs top-level terms by default, and the
  // per-token quoting still neutralizes FTS operator characters (injection-safe).
  const terms = q.replace(/["*]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return '""';
  return terms.map((t) => `"${t}"`).join(match === "any" ? " OR " : " ");
}

interface DocRow {
  id: string;
  scope: string;
  kind: string;
  path: string;
  workspace: string | null;
  title: string | null;
  body: string;
  frontmatter_json: string | null;
  content_hash: string;
  source_ref: string | null;
  updated_at: string;
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
    frontmatter: r.frontmatter_json ? (JSON.parse(r.frontmatter_json) as Record<string, unknown>) : undefined,
    contentHash: r.content_hash,
    sourceRef: r.source_ref ?? undefined,
    updatedAt: r.updated_at,
  };
}

export function createSqliteMemoryStore(db: DB): MemoryStore {
  return {
    async upsertDoc(doc) {
      db.prepare(
        `INSERT INTO memory_docs(id,scope,kind,path,workspace,title,body,frontmatter_json,content_hash,source_ref,updated_at)
         VALUES (@id,@scope,@kind,@path,@workspace,@title,@body,@frontmatter_json,@content_hash,@source_ref,@updated_at)
         ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,kind=excluded.kind,path=excluded.path,workspace=excluded.workspace,
           title=excluded.title,body=excluded.body,frontmatter_json=excluded.frontmatter_json,content_hash=excluded.content_hash,
           source_ref=excluded.source_ref,updated_at=excluded.updated_at`,
      ).run({
        id: doc.id,
        scope: doc.scope,
        kind: doc.kind,
        path: doc.path,
        workspace: doc.workspace ?? null,
        title: doc.title ?? null,
        body: doc.body,
        frontmatter_json: doc.frontmatter ? JSON.stringify(doc.frontmatter) : null,
        content_hash: doc.contentHash,
        source_ref: doc.sourceRef ?? null,
        updated_at: doc.updatedAt,
      });
    },

    async getDoc(id) {
      const r = db.prepare("SELECT * FROM memory_docs WHERE id=?").get(id) as DocRow | undefined;
      return r ? toDoc(r) : null;
    },

    async listDocs(opts) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.scope) {
        clauses.push("scope=?");
        params.push(opts.scope);
      }
      if (opts.kind) {
        clauses.push("kind=?");
        params.push(opts.kind);
      }
      if (opts.workspace) {
        clauses.push("workspace=?");
        params.push(opts.workspace);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM memory_docs ${where} ORDER BY updated_at DESC`).all(...params) as DocRow[];
      return rows.map(toDoc);
    },

    async search(query, opts) {
      const limit = opts?.limit ?? 20;
      // Without ORDER BY, FTS5 yields rows in rowid order, so LIMIT returned the
      // oldest-inserted matches rather than the best ones. bm25() is negative
      // and more-negative is a better match, hence ASC here and the sign flip
      // when normalizing.
      // No alias on memory_fts: FTS5 auxiliary functions must name the table
      // itself, and an aliased table is not addressable by its original name.
      const from = "FROM memory_fts JOIN memory_docs d ON d.rowid=memory_fts.rowid";
      const rows = (
        opts?.scope
          ? db
              .prepare(
                `SELECT d.*, bm25(memory_fts) AS bm25_rank ${from}`
                + " WHERE memory_fts MATCH ? AND d.scope=? ORDER BY bm25_rank ASC LIMIT ?",
              )
              .all(ftsQuery(query, opts.match), opts.scope, limit)
          : db
              .prepare(
                `SELECT d.*, bm25(memory_fts) AS bm25_rank ${from}`
                + " WHERE memory_fts MATCH ? ORDER BY bm25_rank ASC LIMIT ?",
              )
              .all(ftsQuery(query, opts?.match), limit)
      ) as Array<DocRow & { bm25_rank: number }>;
      return normalizeRelevance(rows, (r) => -r.bm25_rank).map((r) => ({
        ...toDoc(r),
        relevance: r.relevance,
      }));
    },

    async removeDoc(id) {
      db.prepare("DELETE FROM memory_docs WHERE id=?").run(id);
    },
  };
}
