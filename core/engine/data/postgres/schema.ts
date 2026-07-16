/** PostgreSQL DDL for the Kyrei data layer. Requirements §10.1, §10.4. */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace TEXT,
  title TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  provider_id TEXT,
  model_id TEXT,
  provider_account_id TEXT,
  meta_json JSONB,
  jsonl_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_ws ON sessions(workspace, started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  parts_json JSONB NOT NULL,
  text TEXT,
  tool_call_id TEXT,
  token_est INTEGER,
  compacted BOOLEAN NOT NULL DEFAULT FALSE,
  ccr_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  client_id TEXT,
  pending BOOLEAN NOT NULL DEFAULT FALSE,
  turn_status TEXT,
  approval_model_params_json JSONB,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_text_gin ON messages USING GIN(to_tsvector('english', COALESCE(text, '')));

CREATE TABLE IF NOT EXISTS memory_docs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  workspace TEXT,
  title TEXT,
  body TEXT NOT NULL,
  frontmatter_json JSONB,
  content_hash TEXT NOT NULL,
  source_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memdocs_scope ON memory_docs(scope, kind);
CREATE INDEX IF NOT EXISTS idx_memdocs_text_gin ON memory_docs USING GIN(
  to_tsvector('english', COALESCE(title, '') || ' ' || body)
);

CREATE TABLE IF NOT EXISTS vectors (
  id BIGSERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding vector,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_type, owner_id, chunk_index, model)
);
CREATE INDEX IF NOT EXISTS idx_vectors_owner ON vectors(owner_type, owner_id);
`;
