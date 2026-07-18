/**
 * Operator-facing status and one-shot reindex for the rebuildable memory index.
 * Files remain SoT; this only reports / refreshes the FTS+vector projection.
 */

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createStores, createStoresAsync, type Stores } from "../data/index.js";
import {
  buildProjectIndexIncremental,
  persistProjectIndex,
} from "../intel/project-index.js";
import type { MemoryIndexConfig } from "./index-backend.js";
import { reindexProjectMemory } from "./project-indexer.js";
import {
  projectSessionsIntoMemory,
  type ProjectableSession,
} from "./session-project.js";
import { configureEmbedAdapterFromConfig, type EmbedConfig } from "./embed-adapter.js";
import type { VaultConfig } from "./vault.js";
import { normalizeWorkspaceTag, sameWorkspaceTag } from "./workspace-id.js";

export interface MemoryIndexStatus {
  state: "ready" | "disabled" | "no_workspace" | "error";
  enabled: boolean;
  backend: "sqlite" | "postgres" | "off" | "file";
  configuredBackend: "sqlite" | "postgres" | "off";
  indexDir: string | null;
  vectorSearch: "sqlite-vec" | "pgvector" | "bruteforce" | "none";
  docCount: number;
  vectorCapable: boolean;
  tierA: {
    memoryMd: boolean;
    notesMd: boolean;
    plan: boolean;
    handoffs: number;
    ltmDecisions: boolean;
    projectIndex: boolean;
  };
  message?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countHandoffs(workspace: string): Promise<number> {
  try {
    const names = await readdir(join(workspace, ".kyrei", "handoff"));
    return names.filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function inspectTierA(workspace: string): Promise<MemoryIndexStatus["tierA"]> {
  return {
    memoryMd: await pathExists(join(workspace, ".kyrei", "memory", "MEMORY.md")),
    notesMd: await pathExists(join(workspace, ".kyrei", "memory", "notes.md")),
    plan: await pathExists(join(workspace, ".kyrei", "plan", "ROADMAP.md")),
    handoffs: await countHandoffs(workspace),
    ltmDecisions: await pathExists(join(workspace, "ltm", "store", "decisions.jsonl")),
    projectIndex: await pathExists(join(workspace, ".kyrei", "intel", "project-index.json")),
  };
}

async function openStores(workspace: string, config: MemoryIndexConfig): Promise<Stores> {
  const baseDir = join(workspace, ".kyrei", "index");
  if (config.backend === "postgres") {
    if (!config.connectionString?.trim()) {
      throw new Error("postgres_connection_required");
    }
    return createStoresAsync({
      baseDir,
      backend: "postgres",
      connectionString: config.connectionString,
    });
  }
  return createStores(baseDir);
}

export async function inspectWorkspaceMemoryIndex(opts: {
  workspace?: string | null;
  config?: MemoryIndexConfig;
}): Promise<MemoryIndexStatus> {
  const workspace = opts.workspace?.trim() ? normalizeWorkspaceTag(opts.workspace) : "";
  const config: MemoryIndexConfig = {
    enabled: opts.config?.enabled !== false,
    backend: opts.config?.backend === "postgres"
      ? "postgres"
      : opts.config?.backend === "off"
        ? "off"
        : "sqlite",
    ...(opts.config?.connectionString ? { connectionString: opts.config.connectionString } : {}),
  };

  if (!workspace) {
    return {
      state: "no_workspace",
      enabled: Boolean(config.enabled),
      backend: "off",
      configuredBackend: config.backend ?? "sqlite",
      indexDir: null,
      vectorSearch: "none",
      docCount: 0,
      vectorCapable: false,
      tierA: {
        memoryMd: false,
        notesMd: false,
        plan: false,
        handoffs: 0,
        ltmDecisions: false,
        projectIndex: false,
      },
      message: "workspace_not_configured",
    };
  }

  const indexDir = join(workspace, ".kyrei", "index");
  const tierA = await inspectTierA(workspace);

  if (config.enabled === false || config.backend === "off") {
    return {
      state: "disabled",
      enabled: false,
      backend: "off",
      configuredBackend: config.backend ?? "off",
      indexDir,
      vectorSearch: "none",
      docCount: 0,
      vectorCapable: false,
      tierA,
      message: "index_disabled",
    };
  }

  let stores: Stores | null = null;
  try {
    stores = await openStores(workspace, config);
    const all = (await stores.memory.listDocs({})).filter((doc) =>
      !doc.workspace || sameWorkspaceTag(doc.workspace, workspace)
    );
    return {
      state: "ready",
      enabled: true,
      backend: stores.backend === "file" ? "file" : stores.backend,
      configuredBackend: config.backend ?? "sqlite",
      indexDir,
      vectorSearch: stores.vectorSearch,
      docCount: all.length,
      vectorCapable: stores.vectorSearch !== "bruteforce" || stores.backend !== "file",
      tierA,
    };
  } catch (error) {
    return {
      state: "error",
      enabled: true,
      backend: "off",
      configuredBackend: config.backend ?? "sqlite",
      indexDir,
      vectorSearch: "none",
      docCount: 0,
      vectorCapable: false,
      tierA,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (stores) {
      try {
        await stores.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function reindexWorkspaceMemoryIndex(opts: {
  workspace: string;
  config?: MemoryIndexConfig;
  ltmEnabled?: boolean;
  planningEnabled?: boolean;
  /**
   * Optional chat session corpus from gateway SessionStore (JSON SoT).
   * Projected into FTS for cross-session search without migrating chat storage.
   */
  sessions?: readonly ProjectableSession[];
  /** Exact secret values scrubbed from session projections. */
  sensitiveValues?: readonly string[];
  /** External markdown vault config, including disabled state for pruning. */
  vault?: VaultConfig;
  /**
   * Refresh the deterministic project graph before rebuilding the memory
   * projection. Reserved for explicit operator rebuilds because repository
   * scanning can be too expensive for every memory mutation.
   */
  refreshProjectIndex?: boolean;
}): Promise<{
  ok: boolean;
  upserted: number;
  vectorsUpserted: number;
  sessionUpserted: number;
  sources: string[];
  status: MemoryIndexStatus;
  projectFiles?: number;
  projectTruncated?: boolean;
  projectPruned?: number;
  error?: string;
}> {
  const config: MemoryIndexConfig = {
    enabled: opts.config?.enabled !== false,
    backend: opts.config?.backend === "postgres"
      ? "postgres"
      : opts.config?.backend === "off"
        ? "off"
        : "sqlite",
    ...(opts.config?.connectionString ? { connectionString: opts.config.connectionString } : {}),
  };

  if (config.enabled === false || config.backend === "off") {
    const status = await inspectWorkspaceMemoryIndex({ workspace: opts.workspace, config });
    return {
      ok: false,
      upserted: 0,
      vectorsUpserted: 0,
      sessionUpserted: 0,
      sources: [],
      status,
      error: "index_disabled",
    };
  }

  let stores: Stores | null = null;
  let projectFiles: number | undefined;
  let projectTruncated: boolean | undefined;
  try {
    if (opts.refreshProjectIndex) {
      const projectIndex = await buildProjectIndexIncremental(opts.workspace);
      await persistProjectIndex(opts.workspace, projectIndex);
      projectFiles = projectIndex.fileCount;
      projectTruncated = projectIndex.truncated;
    }
    if (config.embed) {
      configureEmbedAdapterFromConfig(config.embed as EmbedConfig);
    }
    stores = await openStores(opts.workspace, config);
    const openedBackend = stores.backend;
    const result = await reindexProjectMemory({
      workspace: opts.workspace,
      memory: stores.memory,
      vectors: stores.vectors,
      ltmEnabled: opts.ltmEnabled !== false,
      planningEnabled: opts.planningEnabled !== false,
      ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
    });
    let sessionUpserted = 0;
    const sources = [...result.sources];
    if (opts.refreshProjectIndex) sources.unshift("project_index");
    // Rebuild is an explicit operator operation. It must not silently drop
    // sessions: callers may batch/progress it, but a completed rebuild is
    // complete for the snapshot it was given.
    const sessions = opts.sessions?.length ? opts.sessions : undefined;
    if (sessions?.length) {
      const projected = await projectSessionsIntoMemory(sessions, {
        workspace: opts.workspace,
        memory: stores.memory,
        vectors: stores.vectors,
        sensitiveValues: opts.sensitiveValues,
        pruneStale: true,
        maxSessions: sessions.length,
      });
      sessionUpserted = projected.upserted;
      if (projected.upserted > 0) sources.push("session");
    }
    await stores.close();
    stores = null;
    const status = await inspectWorkspaceMemoryIndex({ workspace: opts.workspace, config });
    // Surface degraded backend so operators know SQLite native failed (file store is durable now).
    if (openedBackend === "file" && !status.message) {
      status.message = "sqlite_unavailable_using_file_backend";
    }
    return {
      ok: true,
      upserted: result.upserted + sessionUpserted,
      vectorsUpserted: result.vectorsUpserted,
      sessionUpserted,
      sources,
      status,
      ...(projectFiles !== undefined ? { projectFiles } : {}),
      ...(projectTruncated !== undefined ? { projectTruncated } : {}),
      ...(result.pruned > 0 ? { projectPruned: result.pruned } : {}),
    };
  } catch (error) {
    if (stores) {
      try {
        await stores.close();
      } catch {
        /* ignore */
      }
    }
    const status = await inspectWorkspaceMemoryIndex({ workspace: opts.workspace, config });
    return {
      ok: false,
      upserted: 0,
      vectorsUpserted: 0,
      sessionUpserted: 0,
      sources: [],
      status,
      ...(projectFiles !== undefined ? { projectFiles } : {}),
      ...(projectTruncated !== undefined ? { projectTruncated } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
