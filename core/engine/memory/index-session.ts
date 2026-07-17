/**
 * Process-wide memory index sessions: open once, share across concurrent turns
 * for the same workspace, reindex on mutation, release with idle TTL.
 *
 * Files remain SoT. This only owns the rebuildable FTS/vector projection.
 */

import { join } from "node:path";
import type { MemoryStore, VectorStore } from "../data/ports.js";
import type { Stores } from "../data/index.js";
import {
  openMemoryIndex,
  closeMemoryIndex,
  type MemoryIndexConfig,
  type MemoryIndexBackend,
} from "./index-backend.js";
import { reindexProjectMemory } from "./project-indexer.js";

const IDLE_CLOSE_MS = 60_000;
const REINDEX_DEBOUNCE_MS = 300;

interface PoolEntry {
  key: string;
  workspace: string;
  config: MemoryIndexConfig;
  stores: Stores;
  backend: MemoryIndexBackend | "file";
  refs: number;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  reindexInFlight: Promise<void> | null;
  dirty: boolean;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, PoolEntry>();

function poolKey(workspace: string, config: MemoryIndexConfig): string {
  const backend = config.backend ?? "sqlite";
  const cs = config.connectionString?.trim() ?? "";
  return `${workspace.replace(/\\/g, "/")}::${backend}::${cs}`;
}

async function ensureEntry(workspace: string, config: MemoryIndexConfig): Promise<PoolEntry | null> {
  const key = poolKey(workspace, config);
  const existing = pool.get(key);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    existing.refs += 1;
    existing.lastUsed = Date.now();
    return existing;
  }

  const opened = await openMemoryIndex(workspace, config);
  if (!opened.stores) return null;

  const entry: PoolEntry = {
    key,
    workspace,
    config,
    stores: opened.stores,
    backend: opened.backend,
    refs: 1,
    lastUsed: Date.now(),
    reindexInFlight: null,
    dirty: true,
  };
  pool.set(key, entry);
  return entry;
}

async function runReindex(entry: PoolEntry, opts: {
  ltmEnabled?: boolean;
  planningEnabled?: boolean;
  vault?: import("./vault.js").VaultConfig;
}): Promise<void> {
  if (entry.reindexInFlight) {
    await entry.reindexInFlight;
    if (!entry.dirty) return;
  }
  const work = (async () => {
    entry.dirty = false;
    try {
      await reindexProjectMemory({
        workspace: entry.workspace,
        memory: entry.stores.memory,
        vectors: entry.stores.vectors,
        ltmEnabled: opts.ltmEnabled,
        planningEnabled: opts.planningEnabled,
        ...(opts.vault ? { vault: opts.vault } : {}),
      });
    } catch (error) {
      entry.dirty = true;
      console.warn("[kyrei memory-index] reindex failed:", error);
    } finally {
      entry.reindexInFlight = null;
    }
  })();
  entry.reindexInFlight = work;
  await work;
}

function scheduleIdleClose(entry: PoolEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void (async () => {
      if (entry.refs > 0) return;
      pool.delete(entry.key);
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      await closeMemoryIndex(entry.stores);
    })();
  }, IDLE_CLOSE_MS);
  // Don't keep the process alive only for the idle closer.
  entry.idleTimer.unref?.();
}

export interface MemoryIndexSessionOptions {
  workspace: string;
  config: MemoryIndexConfig;
  ltmEnabled?: boolean;
  planningEnabled?: boolean;
  /** Wave C3 external vault roots (optional). */
  vault?: import("./vault.js").VaultConfig;
}

/**
 * Acquired handle for one agent turn (or team fan-out under that turn).
 * Always call `release()` in a finally block.
 */
export class MemoryIndexSession {
  private constructor(
    private readonly entry: PoolEntry | null,
    private readonly ltmEnabled: boolean,
    private readonly planningEnabled: boolean,
    private readonly vault: import("./vault.js").VaultConfig | undefined,
    private released = false,
  ) {}

  static async acquire(options: MemoryIndexSessionOptions): Promise<MemoryIndexSession> {
    const enabled = options.config.enabled !== false && options.config.backend !== "off";
    if (!enabled) {
      return new MemoryIndexSession(
        null,
        Boolean(options.ltmEnabled),
        Boolean(options.planningEnabled),
        options.vault,
      );
    }
    const entry = await ensureEntry(options.workspace, options.config);
    return new MemoryIndexSession(
      entry,
      Boolean(options.ltmEnabled),
      Boolean(options.planningEnabled),
      options.vault,
    );
  }

  get backendLabel(): string {
    return this.entry?.backend ?? "off";
  }

  get memoryStore(): MemoryStore | undefined {
    return this.entry?.stores.memory;
  }

  get vectorStore(): VectorStore | undefined {
    return this.entry?.stores.vectors;
  }

  get active(): boolean {
    return Boolean(this.entry);
  }

  private reindexOpts() {
    return {
      ltmEnabled: this.ltmEnabled,
      planningEnabled: this.planningEnabled,
      ...(this.vault ? { vault: this.vault } : {}),
    };
  }

  /** Full reindex now (awaited). Safe to call multiple times. */
  async reindexNow(): Promise<void> {
    if (!this.entry) return;
    await runReindex(this.entry, this.reindexOpts());
  }

  /**
   * Mark Tier A mutated; debounced reindex keeps mid-turn search fresh without
   * blocking every write_file.
   */
  notifyMutated(): void {
    if (!this.entry || this.released) return;
    this.entry.dirty = true;
    this.entry.lastUsed = Date.now();
    if (this.entry.debounceTimer) clearTimeout(this.entry.debounceTimer);
    this.entry.debounceTimer = setTimeout(() => {
      void runReindex(this.entry!, this.reindexOpts());
    }, REINDEX_DEBOUNCE_MS);
    this.entry.debounceTimer.unref?.();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (!this.entry) return;
    // Flush pending reindex so the next turn sees a warm index when possible.
    if (this.entry.debounceTimer) {
      clearTimeout(this.entry.debounceTimer);
      this.entry.debounceTimer = undefined;
      if (this.entry.dirty) {
        await runReindex(this.entry, this.reindexOpts());
      }
    } else if (this.entry.reindexInFlight) {
      await this.entry.reindexInFlight.catch(() => undefined);
    }
    this.entry.refs = Math.max(0, this.entry.refs - 1);
    this.entry.lastUsed = Date.now();
    if (this.entry.refs === 0) scheduleIdleClose(this.entry);
  }
}

/** Test helper: drop idle entries immediately (does not force-close active refs). */
export async function flushMemoryIndexPoolForTests(): Promise<void> {
  const entries = [...pool.values()];
  for (const entry of entries) {
    if (entry.refs > 0) continue;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    pool.delete(entry.key);
    await closeMemoryIndex(entry.stores);
  }
}

/** Test helper: number of pooled backends (including idle). */
export function memoryIndexPoolSizeForTests(): number {
  return pool.size;
}

export function workspaceIndexDir(workspace: string): string {
  return join(workspace, ".kyrei", "index");
}
