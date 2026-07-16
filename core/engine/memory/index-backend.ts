/**
 * Open the rebuildable memory index for a workspace.
 *
 * Default: SQLite under `<workspace>/.kyrei/index/index.db` (local, offline).
 * Optional: Postgres when configured — shared FTS for multi-host teams.
 * Graph / plan / LTM ledgers stay on the workspace filesystem (Tier A).
 */

import { join } from "node:path";
import {
  createStores,
  createStoresAsync,
  type Stores,
} from "../data/index.js";

export type MemoryIndexBackend = "sqlite" | "postgres" | "off";

export interface MemoryIndexConfig {
  /** When false / backend off, no index is opened. Default true → sqlite. */
  enabled?: boolean;
  backend?: MemoryIndexBackend;
  /**
   * Postgres connection string. Required when backend is `postgres`.
   * Never used for code graph or plan-as-files SoT.
   */
  connectionString?: string;
  /** Optional embed config applied by reindex/inspect callers. */
  embed?: {
    mode: "lexical" | "http";
    baseURL?: string;
    model?: string;
    apiKey?: string;
    timeoutMs?: number;
    dim?: number;
  };
}

export interface OpenMemoryIndexResult {
  stores: Stores | null;
  backend: MemoryIndexBackend | "file";
  baseDir?: string;
}

/**
 * Open memory index stores. Never throws for sqlite failure — falls back to
 * null so callers use file-based memory_search only.
 */
export async function openMemoryIndex(
  workspace: string,
  config: MemoryIndexConfig = {},
): Promise<OpenMemoryIndexResult> {
  const enabled = config.enabled !== false;
  const backend: MemoryIndexBackend = !enabled
    ? "off"
    : config.backend === "postgres"
      ? "postgres"
      : config.backend === "off"
        ? "off"
        : "sqlite";

  if (backend === "off") {
    return { stores: null, backend: "off" };
  }

  if (backend === "postgres") {
    if (!config.connectionString?.trim()) {
      console.warn("[kyrei memory-index] postgres backend needs connectionString; skipping index");
      return { stores: null, backend: "off" };
    }
    try {
      const stores = await createStoresAsync({
        baseDir: join(workspace, ".kyrei", "index"),
        backend: "postgres",
        connectionString: config.connectionString,
      });
      return { stores, backend: "postgres" };
    } catch (error) {
      console.warn(
        "[kyrei memory-index] postgres unavailable, falling back to sqlite:",
        (error as Error).message,
      );
      // fall through to sqlite so solo still works
    }
  }

  const baseDir = join(workspace, ".kyrei", "index");
  try {
    // Prefer async path so postgres→sqlite fallback stays consistent.
    const stores = await createStoresAsync({ baseDir, backend: "sqlite" });
    return { stores, backend: stores.backend === "file" ? "file" : "sqlite", baseDir };
  } catch (error) {
    console.warn("[kyrei memory-index] sqlite open failed:", (error as Error).message);
    try {
      const stores = createStores(baseDir);
      return { stores, backend: stores.backend === "file" ? "file" : "sqlite", baseDir };
    } catch (err2) {
      console.warn("[kyrei memory-index] disabled:", (err2 as Error).message);
      return { stores: null, backend: "off" };
    }
  }
}

export async function closeMemoryIndex(stores: Stores | null | undefined): Promise<void> {
  if (!stores) return;
  try {
    await stores.close();
  } catch {
    /* ignore close errors */
  }
}
