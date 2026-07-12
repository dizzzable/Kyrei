/** SQLite DDL for the Kyrei data layer (Phase 5). Requirements §10.1. */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  workspace   TEXT,
  title       TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  meta_json   TEXT,
  jsonl_path  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_ws ON sessions(workspace, started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  parts_json   TEXT NOT NULL,
  text         TEXT,
  tool_call_id TEXT,
  token_est    INTEGER,
  compacted    INTEGER NOT NULL DEFAULT 0,
  ccr_hash     TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS memory_docs (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  workspace     TEXT,
  title         TEXT,
  body          TEXT NOT NULL,
  frontmatter_json TEXT,
  content_hash  TEXT NOT NULL,
  source_ref    TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memdocs_scope ON memory_docs(scope, kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, body, content='memory_docs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memdocs_ai AFTER INSERT ON memory_docs BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memdocs_ad AFTER DELETE ON memory_docs BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memdocs_au AFTER UPDATE ON memory_docs BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS vectors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  embedding    BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(owner_type, owner_id, chunk_index, model)
);
CREATE INDEX IF NOT EXISTS idx_vectors_owner ON vectors(owner_type, owner_id);
`;
