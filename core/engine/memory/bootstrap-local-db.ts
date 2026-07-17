/**
 * OOB local-store bootstrap: create SQLite schemas and workspace Tier-A dirs
 * without requiring the user to click "Rebuild index" first.
 *
 * No external DB server is started — only local files under dataDir / workspace.
 */

import { mkdir, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStores } from "../data/index.js";
import type { MemoryIndexConfig } from "./index-backend.js";
import { openMemoryIndex, closeMemoryIndex } from "./index-backend.js";

export interface GatewayBootstrapResult {
  ok: boolean;
  sessionMirror: {
    ok: boolean;
    path: string;
    backend: string;
    error?: string;
  };
}

export interface WorkspaceBootstrapResult {
  ok: boolean;
  workspace: string;
  dirs: string[];
  index: {
    ok: boolean;
    path: string;
    backend: string;
    error?: string;
  };
  graph: {
    ok: boolean;
    path: string;
    error?: string;
  };
  /** True when an empty MEMORY.md seed was written (first-time only). */
  seededMemoryMd: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open (and thus create) gateway-scoped SQLite under dataDir/session-mirror.
 * Safe to call on every start — idempotent schema.
 */
export function bootstrapGatewayLocalStores(dataDir: string): GatewayBootstrapResult {
  const mirrorPath = join(dataDir, "session-mirror");
  try {
    const stores = createStores(mirrorPath);
    try {
      stores.close();
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      sessionMirror: {
        ok: true,
        path: mirrorPath,
        backend: stores.backend,
      },
    };
  } catch (error) {
    return {
      ok: false,
      sessionMirror: {
        ok: false,
        path: mirrorPath,
        backend: "off",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Ensure workspace .kyrei layout + empty SQLite memory index + graph DB exist.
 * Does not scan the whole repo or block on full reindex.
 */
export async function bootstrapWorkspaceLocalStores(opts: {
  workspace: string;
  config?: MemoryIndexConfig;
  /** Write a short MEMORY.md starter if missing (default true). */
  seedMemoryMd?: boolean;
}): Promise<WorkspaceBootstrapResult> {
  const workspace = opts.workspace.trim();
  const dirsCreated: string[] = [];
  const relDirs = [
    join(workspace, ".kyrei"),
    join(workspace, ".kyrei", "memory"),
    join(workspace, ".kyrei", "intel"),
    join(workspace, ".kyrei", "index"),
    join(workspace, ".kyrei", "handoff"),
    join(workspace, ".kyrei", "plan"),
  ];

  for (const dir of relDirs) {
    await mkdir(dir, { recursive: true });
    dirsCreated.push(dir);
  }

  let seededMemoryMd = false;
  if (opts.seedMemoryMd !== false) {
    const memoryPath = join(workspace, ".kyrei", "memory", "MEMORY.md");
    if (!(await pathExists(memoryPath))) {
      await writeFile(
        memoryPath,
        [
          "# Project memory",
          "",
          "Durable notes for this workspace. Kyrei indexes this file into the local",
          "search store (`.kyrei/index/`) automatically — files remain source of truth.",
          "",
        ].join("\n"),
        "utf8",
      );
      seededMemoryMd = true;
    }
  }

  const indexPath = join(workspace, ".kyrei", "index");
  let indexOk = false;
  let indexBackend = "off";
  let indexError: string | undefined;
  try {
    const opened = await openMemoryIndex(workspace, {
      enabled: opts.config?.enabled !== false,
      backend: opts.config?.backend === "off" ? "off" : opts.config?.backend === "postgres" ? "postgres" : "sqlite",
      ...(opts.config?.connectionString ? { connectionString: opts.config.connectionString } : {}),
    });
    if (opened.stores) {
      indexOk = true;
      indexBackend = opened.backend;
      await closeMemoryIndex(opened.stores);
    } else {
      indexError = "index_disabled_or_unavailable";
    }
  } catch (error) {
    indexError = error instanceof Error ? error.message : String(error);
  }

  const graphPath = join(workspace, ".kyrei", "intel", "project-graph.db");
  let graphOk = false;
  let graphError: string | undefined;
  try {
    const { openGraphDb } = await import("../intel/graph-store.js");
    const db = openGraphDb(graphPath);
    db.close();
    graphOk = true;
  } catch (error) {
    graphError = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: indexOk || graphOk,
    workspace,
    dirs: dirsCreated,
    index: {
      ok: indexOk,
      path: indexPath,
      backend: indexBackend,
      ...(indexError ? { error: indexError } : {}),
    },
    graph: {
      ok: graphOk,
      path: graphPath,
      ...(graphError ? { error: graphError } : {}),
    },
    seededMemoryMd,
  };
}
