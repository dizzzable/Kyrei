/**
 * Embedded, loopback-only PostgreSQL runtime for Team mode.
 *
 * Kyrei keeps SQLite as the offline default. When Team mode needs a shared
 * Postgres-compatible index and no external connection is configured, this
 * module starts a persistent PGlite database behind the PostgreSQL wire
 * protocol. It is intentionally lazy, bound to 127.0.0.1, and never exposed
 * to the LAN.
 */

import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_CONNECTIONS = 8;

/**
 * @typedef {"stopped"|"starting"|"ready"|"error"} LocalPostgresState
 * @typedef {{
 *   state: LocalPostgresState,
 *   host: string,
 *   port: number,
 *   vector: boolean,
 *   connectionString?: string,
 *   error?: string,
 * }} LocalPostgresStatus
 */

function errorText(error) {
  const message = String(error?.message ?? error ?? "local_postgres_error").trim();
  return message.slice(0, 500) || "local_postgres_error";
}

function databaseScopeKey(workspace) {
  const value = typeof workspace === "string" && workspace.trim()
    ? workspace.trim().replace(/\\/g, "/").toLowerCase()
    : "default";
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * @param {{
 *   dataDir: string,
 *   maxConnections?: number,
 *   logger?: Pick<Console, "warn" | "error">,
 *   pgliteFactory?: (dataDir: string, options?: object) => Promise<object>,
 *   socketServerFactory?: (options: object) => object,
 * }} options
 */
export function createLocalPostgres({
  dataDir,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  logger = console,
  pgliteFactory,
  socketServerFactory,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("local_postgres_data_dir_required");
  }

  /** @type {LocalPostgresState} */
  let state = "stopped";
  let port = 0;
  let connectionString;
  let vector = false;
  let error;
  let db;
  let server;
  let activeScopeKey;
  let transition = Promise.resolve();
  let factoriesPromise;

  const status = () => ({
    state,
    host: LOOPBACK_HOST,
    port,
    vector,
    ...(connectionString ? { connectionString } : {}),
    ...(error ? { error } : {}),
  });

  const loadFactories = async () => {
    if (pgliteFactory && socketServerFactory) return { pgliteFactory, socketServerFactory };
    factoriesPromise ??= Promise.all([
      import("@electric-sql/pglite"),
      import("@electric-sql/pglite-pgvector"),
      import("@electric-sql/pglite-socket"),
    ]).then(([{ PGlite }, { vector: vectorExtension }, { PGLiteSocketServer }]) => ({
      pgliteFactory: async (path, options) => PGlite.create(path, options),
      socketServerFactory: (options) => new PGLiteSocketServer(options),
      vectorExtension,
    }));
    return factoriesPromise;
  };

  const stopActive = async () => {
    try { await server?.stop?.(); } catch (cause) { logger.warn?.("[kyrei local-postgres] stop failed:", errorText(cause)); }
    try { await db?.close?.(); } catch (cause) { logger.warn?.("[kyrei local-postgres] database close failed:", errorText(cause)); }
    server = undefined;
    db = undefined;
    state = "stopped";
    port = 0;
    connectionString = undefined;
    vector = false;
    error = undefined;
    activeScopeKey = undefined;
  };

  const start = async (scopeKey) => {
    if (state === "ready" && activeScopeKey === scopeKey) return status();
    if (state !== "stopped" || server || db) await stopActive();
    state = "starting";
    error = undefined;
    const databaseDir = join(dataDir, scopeKey);
    try {
      const factories = await loadFactories();
      await mkdir(databaseDir, { recursive: true });

      let vectorExtension = factories.vectorExtension;
      if (vectorExtension === undefined) {
        try {
          ({ vector: vectorExtension } = await import("@electric-sql/pglite-pgvector"));
        } catch {
          vectorExtension = undefined;
        }
      }

      try {
        db = await factories.pgliteFactory(
          databaseDir,
          vectorExtension ? { extensions: { vector: vectorExtension } } : undefined,
        );
        vector = Boolean(vectorExtension);
      } catch (firstError) {
        // The database remains useful without pgvector: Kyrei's Postgres
        // vector store degrades to bounded JS cosine search in that case.
        if (!vectorExtension) throw firstError;
        logger.warn?.("[kyrei local-postgres] pgvector extension unavailable; retrying without it:", errorText(firstError));
        db = await factories.pgliteFactory(databaseDir);
        vector = false;
      }

      server = factories.socketServerFactory({
        db,
        host: LOOPBACK_HOST,
        port: 0,
        maxConnections: Math.max(1, Math.min(32, Math.floor(maxConnections))),
      });
      await server.start();
      port = Number(server.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("local_postgres_port_invalid");
      }
      connectionString = `postgresql://postgres@${LOOPBACK_HOST}:${port}/postgres?sslmode=disable`;
      activeScopeKey = scopeKey;
      state = "ready";
      return status();
    } catch (cause) {
      state = "error";
      error = errorText(cause);
      logger.error?.("[kyrei local-postgres] failed to start:", error);
      try { await server?.stop?.(); } catch { /* best effort */ }
      try { await db?.close?.(); } catch { /* best effort */ }
      server = undefined;
      db = undefined;
      port = 0;
      connectionString = undefined;
      vector = false;
      activeScopeKey = undefined;
      return status();
    }
  };

  const enqueue = (operation) => {
    const result = transition.then(operation, operation);
    transition = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    ensure(workspace) {
      const scopeKey = databaseScopeKey(workspace);
      return enqueue(() => start(scopeKey));
    },
    getStatus: status,
    async close() {
      await enqueue(stopActive);
    },
  };
}

export const LOCAL_POSTGRES_HOST = LOOPBACK_HOST;
