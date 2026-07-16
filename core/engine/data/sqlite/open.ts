/** Opens the SQLite database, sets pragmas, loads sqlite-vec, applies schema. */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type DB = Database.Database;

export interface OpenResult {
  db: DB;
  vecOk: boolean;
}

export function openDb(path: string): OpenResult {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  let vecOk = false;
  try {
    sqliteVec.load(db);
    vecOk = true;
  } catch {
    /* vector search degrades to brute-force JS cosine */
  }

  db.exec(SCHEMA_SQL);
  migrateSessionCutoverColumns(db);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    String(SCHEMA_VERSION),
  );
  return { db, vecOk };
}

/** Additive ALTERs for installs that already had SCHEMA_VERSION 1 tables. */
function migrateSessionCutoverColumns(db: DB): void {
  const sessionCols = new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
  );
  const msgCols = new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
  );
  const alter = (table: string, col: string, ddl: string) => {
    if (table === "sessions" ? sessionCols.has(col) : msgCols.has(col)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  alter("sessions", "provider_id", "provider_id TEXT");
  alter("sessions", "model_id", "model_id TEXT");
  alter("sessions", "provider_account_id", "provider_account_id TEXT");
  alter("messages", "client_id", "client_id TEXT");
  alter("messages", "pending", "pending INTEGER NOT NULL DEFAULT 0");
  alter("messages", "turn_status", "turn_status TEXT");
  alter("messages", "approval_model_params_json", "approval_model_params_json TEXT");
}
