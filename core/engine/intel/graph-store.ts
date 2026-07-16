/**
 * SQLite-backed incremental project graph store (Phase 3C incremental file-level).
 * 
 * Replaces JSON persistence with a durable, incrementally-updated database that
 * tracks file content hashes to avoid re-parsing unchanged files. This is the
 * middle ground validated by experiments: file-level graph (not symbol-level),
 * tool-call triggered (not file-watcher background), SQLite for durability and
 * query speed on large projects.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectEdge, ProjectIndex, ProjectNode } from "./project-index.js";

export const GRAPH_SCHEMA_VERSION = 1;

export const GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS graph_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Nodes: files in the workspace (one row per indexed file)
CREATE TABLE IF NOT EXISTS graph_nodes (
  path TEXT PRIMARY KEY,       -- workspace-relative path (e.g. "src/index.ts")
  language TEXT NOT NULL,      -- detected language
  content_hash TEXT NOT NULL,  -- SHA-256 hex for incremental invalidation
  indexed_at INTEGER NOT NULL  -- unix timestamp ms
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nodes_language ON graph_nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_indexed_at ON graph_nodes(indexed_at);

-- Edges: import/dependency relationships (from → to)
CREATE TABLE IF NOT EXISTS graph_edges (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_path);
CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_path);

-- Metadata for the index as a whole
CREATE TABLE IF NOT EXISTS graph_state (
  workspace TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL,  -- 1 if hit MAX_FILES
  generated_at INTEGER NOT NULL,
  languages_json TEXT NOT NULL,  -- JSON object {"ts":50,"js":10,...}
  top_level_json TEXT NOT NULL,  -- JSON array ["src/main.ts",...]
  entry_candidates_json TEXT NOT NULL
) WITHOUT ROWID;
`;

export type GraphDB = Database.Database;

export function openGraphDb(dbPath: string): GraphDB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  
  db.exec(GRAPH_SCHEMA_SQL);
  db.prepare("INSERT INTO graph_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(GRAPH_SCHEMA_VERSION));
  
  return db;
}

export function hashFileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Check if a file needs re-indexing (hash changed or not in DB). */
export function needsReindex(db: GraphDB, path: string, contentHash: string): boolean {
  const row = db.prepare("SELECT content_hash FROM graph_nodes WHERE path = ?").get(path) as { content_hash: string } | undefined;
  return !row || row.content_hash !== contentHash;
}

/** Store nodes (files) for the incremental index. */
export function upsertNodes(db: GraphDB, nodes: Array<{ path: string; language: string; contentHash: string }>): void {
  const stmt = db.prepare(`
    INSERT INTO graph_nodes (path, language, content_hash, indexed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      language = excluded.language,
      content_hash = excluded.content_hash,
      indexed_at = excluded.indexed_at
  `);
  const now = Date.now();
  const tx = db.transaction((items: Array<{ path: string; language: string; contentHash: string }>) => {
    for (const n of items) {
      stmt.run(n.path, n.language, n.contentHash, now);
    }
  });
  tx(nodes);
}

/** Store edges (dependencies) for given files. Replaces old edges for these files. */
export function replaceEdgesForFiles(db: GraphDB, filePaths: string[], edges: ProjectEdge[]): void {
  const deleteStmt = db.prepare("DELETE FROM graph_edges WHERE from_path = ?");
  const insertStmt = db.prepare("INSERT INTO graph_edges (from_path, to_path) VALUES (?, ?) ON CONFLICT DO NOTHING");
  
  const tx = db.transaction(() => {
    // Delete old edges originating from these files
    for (const path of filePaths) {
      deleteStmt.run(path);
    }
    // Insert new edges
    for (const edge of edges) {
      insertStmt.run(edge.from, edge.to);
    }
  });
  tx();
}

/** Remove nodes (and their edges CASCADE via manual cleanup). */
export function deleteNodes(db: GraphDB, paths: string[]): void {
  const deleteNodeStmt = db.prepare("DELETE FROM graph_nodes WHERE path = ?");
  const deleteEdgesFromStmt = db.prepare("DELETE FROM graph_edges WHERE from_path = ?");
  const deleteEdgesToStmt = db.prepare("DELETE FROM graph_edges WHERE to_path = ?");
  
  const tx = db.transaction((paths: string[]) => {
    for (const path of paths) {
      deleteEdgesFromStmt.run(path);
      deleteEdgesToStmt.run(path);
      deleteNodeStmt.run(path);
    }
  });
  tx(paths);
}

/** Load the full graph state (for building ProjectIndex). */
export function loadGraphState(db: GraphDB, workspace: string): ProjectIndex | null {
  const state = db.prepare("SELECT * FROM graph_state WHERE workspace = ?").get(workspace) as {
    file_count: number;
    truncated: number;
    generated_at: number;
    languages_json: string;
    top_level_json: string;
    entry_candidates_json: string;
  } | undefined;
  
  if (!state) return null;
  
  const nodes = db.prepare("SELECT path, language FROM graph_nodes ORDER BY path").all() as Array<{ path: string; language: string }>;
  const edges = db.prepare("SELECT from_path, to_path FROM graph_edges ORDER BY from_path, to_path").all() as Array<{ from_path: string; to_path: string }>;
  
  return {
    version: 1,
    generatedAt: new Date(state.generated_at).toISOString(),
    workspace,
    fileCount: state.file_count,
    truncated: state.truncated === 1,
    languages: JSON.parse(state.languages_json),
    topLevel: JSON.parse(state.top_level_json),
    entryCandidates: JSON.parse(state.entry_candidates_json),
    nodes: nodes.map(n => ({ path: n.path, language: n.language })),
    edges: edges.map(e => ({ from: e.from_path, to: e.to_path, type: "imports" as const, provenance: "EXTRACTED" as const })),
  };
}

/** Save the full graph state (for completing an index build). */
export function saveGraphState(db: GraphDB, index: ProjectIndex): void {
  const stmt = db.prepare(`
    INSERT INTO graph_state (workspace, file_count, truncated, generated_at, languages_json, top_level_json, entry_candidates_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace) DO UPDATE SET
      file_count = excluded.file_count,
      truncated = excluded.truncated,
      generated_at = excluded.generated_at,
      languages_json = excluded.languages_json,
      top_level_json = excluded.top_level_json,
      entry_candidates_json = excluded.entry_candidates_json
  `);
  
  stmt.run(
    index.workspace,
    index.fileCount,
    index.truncated ? 1 : 0,
    Date.parse(index.generatedAt),
    JSON.stringify(index.languages),
    JSON.stringify(index.topLevel),
    JSON.stringify(index.entryCandidates),
  );
}
