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
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    String(SCHEMA_VERSION),
  );
  return { db, vecOk };
}
