/** Opens a PostgreSQL connection pool, applies schema, validates pgvector. */

import pg from "pg";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

const { Pool } = pg;

export type PgPool = pg.Pool;

export interface OpenResult {
  pool: PgPool;
  vecOk: boolean;
}

export async function openPool(connectionString: string): Promise<OpenResult> {
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000 });

  // Test connection
  const client = await pool.connect();
  try {
    // Check pgvector extension
    let vecOk = false;
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      const res = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
      );
      vecOk = res.rowCount !== null && res.rowCount > 0;
    } catch {
      /* pgvector not available, vector search will degrade to JS cosine */
    }

    // Apply schema
    await client.query(SCHEMA_SQL);
    await migrateSessionCutoverColumns(client);
    await client.query(
      `INSERT INTO schema_meta(key, value) VALUES ('schema_version', $1)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      [String(SCHEMA_VERSION)]
    );

    return { pool, vecOk };
  } finally {
    client.release();
  }
}

/** Additive columns for v1 → v2 cutover schema (idempotent). */
async function migrateSessionCutoverColumns(client: pg.PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS provider_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS provider_account_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_status TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS approval_model_params_json JSONB;
  `);
}
