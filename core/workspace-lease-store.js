import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";

import { redactSensitiveValue } from "./secret-redaction.js";

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_STALE_MS = 30_000;

function safeId(value, name = "id", max = 300) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\0-\x1f]/.test(value)) {
    throw new Error(`workspace_lease_${name}_invalid`);
  }
  return value.trim();
}

function normalizeWorkspace(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 32_000 || value.includes("\0")) {
    throw new Error("workspace_lease_path_invalid");
  }
  let probe = normalize(resolve(value.trim()));
  const suffix = [];
  let canonical;
  for (;;) {
    try {
      canonical = join(realpathSync.native(probe), ...suffix);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw leaseError("workspace_lease_path_unavailable");
      const parent = dirname(probe);
      if (parent === probe) throw leaseError("workspace_lease_path_unavailable");
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
  if (process.platform === "win32") canonical = canonical.toLocaleLowerCase("en-US");
  return canonical;
}

function workspaceHash(value) {
  return createHash("sha256").update(normalizeWorkspace(value)).digest("hex");
}

function leaseError(code, lease) {
  const error = new Error(code);
  error.code = code;
  if (lease) error.lease = structuredClone(lease);
  return error;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validPersistedLease(hash, lease) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !lease || typeof lease !== "object" || Array.isArray(lease)) return false;
  try {
    safeId(lease.id, "id");
    safeId(lease.runId, "run_id");
    safeId(lease.stageId, "stage_id", 160);
    safeId(lease.ownerInstanceId, "instance_id", 300);
  } catch {
    return false;
  }
  return lease.workspaceHash === hash
    && (lease.quarantined === undefined || typeof lease.quarantined === "boolean")
    && validIso(lease.acquiredAt)
    && validIso(lease.renewedAt)
    && validIso(lease.expiresAt)
    && Date.parse(lease.acquiredAt) <= Date.parse(lease.renewedAt)
    && Date.parse(lease.renewedAt) <= Date.parse(lease.expiresAt);
}

async function atomicWrite(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export class WorkspaceLeaseStore {
  constructor({ dataDir, getSensitiveValues = () => [], now = () => new Date(), instanceId = randomUUID(), defaultTtlMs = DEFAULT_TTL_MS, isVerifiedResolution = () => false } = {}) {
    if (typeof dataDir !== "string" || !dataDir) throw new Error("workspace_lease_store_dir_required");
    if (typeof getSensitiveValues !== "function") throw new Error("workspace_lease_store_sensitive_values_invalid");
    if (typeof isVerifiedResolution !== "function") throw new Error("workspace_lease_store_resolution_verifier_invalid");
    this.dir = join(dataDir, "workspace-leases");
    this.file = join(this.dir, "leases.json");
    this.lockDir = join(this.dir, ".mutation-lock");
    this.lockOwnerFile = join(this.lockDir, "owner");
    this.getSensitiveValues = getSensitiveValues;
    this.now = now;
    this.instanceId = safeId(instanceId, "instance_id", 300);
    this.defaultTtlMs = Math.max(1_000, Math.min(24 * 60 * 60 * 1_000, Number(defaultTtlMs) || DEFAULT_TTL_MS));
    this.isVerifiedResolution = isVerifiedResolution;
    this.state = null;
    this.tail = Promise.resolve();
  }

  hashFor(workspace) {
    return workspaceHash(workspace);
  }

  _serialize(operation) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  _nowMs() {
    return this.now().getTime();
  }

  _emptyState() {
    return { schemaVersion: SCHEMA_VERSION, leases: {}, updatedAt: new Date(this._nowMs()).toISOString() };
  }

  async _loadUnlocked({ fresh = false } = {}) {
    if (this.state && !fresh) return this.state;
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.state = this._emptyState();
      return this.state;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw leaseError("workspace_lease_state_corrupt");
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !parsed.leases || typeof parsed.leases !== "object" || Array.isArray(parsed.leases)) {
      throw leaseError("workspace_lease_state_invalid");
    }
    if (!validIso(parsed.updatedAt) || Object.entries(parsed.leases).some(([hash, lease]) => !validPersistedLease(hash, lease))) {
      throw leaseError("workspace_lease_state_invalid");
    }
    this.state = parsed;
    return this.state;
  }

  async _withFileLock(operation) {
    await mkdir(this.dir, { recursive: true });
    const owner = randomUUID();
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(this.lockDir);
        try {
          await writeFile(this.lockOwnerFile, owner, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(this.lockDir);
          if (Date.now() - info.mtimeMs > FILE_LOCK_STALE_MS) {
            await rm(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (inspectionError) {
          if (inspectionError?.code === "ENOENT") continue;
          throw inspectionError;
        }
        if (Date.now() >= deadline) throw leaseError("workspace_lease_store_busy");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      }
    }
    try {
      return await operation();
    } finally {
      const currentOwner = await readFile(this.lockOwnerFile, "utf8").catch(() => "");
      if (currentOwner === owner) await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _saveUnlocked() {
    await mkdir(this.dir, { recursive: true });
    this.state.updatedAt = new Date(this._nowMs()).toISOString();
    const sensitive = this.getSensitiveValues();
    this.state = {
      ...this.state,
      leases: Object.fromEntries(Object.entries(this.state.leases).map(([hash, lease]) => [hash, {
        ...lease,
        ...(lease.resolutionMarker !== undefined
          ? { resolutionMarker: redactSensitiveValue(lease.resolutionMarker, sensitive, { maxDepth: 16, maxStringChars: 8_000 }) }
          : {}),
      }])),
    };
    await atomicWrite(this.file, this.state);
  }

  async load() {
    await this.tail;
    const state = await this._loadUnlocked({ fresh: true });
    return structuredClone(state);
  }

  acquire({ workspace, runId, stageId, ttlMs = this.defaultTtlMs, uncertain = false, writeOutcome, resolutionMarker } = {}) {
    const hash = workspaceHash(workspace);
    const run = safeId(runId, "run_id");
    const stage = safeId(stageId, "stage_id", 160);
    if ((uncertain || writeOutcome === "uncertain") && !this.isVerifiedResolution(resolutionMarker)) {
      return Promise.reject(leaseError("workspace_write_outcome_uncertain"));
    }
    return this._serialize(async () => {
      return this._withFileLock(async () => {
        const state = await this._loadUnlocked({ fresh: true });
        const now = this._nowMs();
        const existing = state.leases[hash];
        if (existing && (existing.quarantined === true || Date.parse(existing.expiresAt) > now)) {
          if (existing.runId !== run || existing.stageId !== stage || existing.ownerInstanceId !== this.instanceId) {
            throw leaseError("workspace_lease_held", existing);
          }
          existing.renewedAt = new Date(now).toISOString();
          existing.expiresAt = new Date(now + Math.max(1_000, Number(ttlMs) || this.defaultTtlMs)).toISOString();
          await this._saveUnlocked();
          return structuredClone(existing);
        }
        const at = new Date(now).toISOString();
        const lease = {
          id: randomUUID(),
          workspaceHash: hash,
          runId: run,
          stageId: stage,
          ownerInstanceId: this.instanceId,
          acquiredAt: at,
          renewedAt: at,
          expiresAt: new Date(now + Math.max(1_000, Number(ttlMs) || this.defaultTtlMs)).toISOString(),
          ...(resolutionMarker != null ? { resolutionMarker } : {}),
        };
        state.leases[hash] = lease;
        await this._saveUnlocked();
        return structuredClone(state.leases[hash]);
      });
    });
  }

  renew({ workspace, leaseId, ttlMs = this.defaultTtlMs } = {}) {
    const hash = workspaceHash(workspace);
    const id = safeId(leaseId, "id");
    return this._serialize(async () => {
      return this._withFileLock(async () => {
        const state = await this._loadUnlocked({ fresh: true });
        const lease = state.leases[hash];
        if (!lease || lease.id !== id || lease.ownerInstanceId !== this.instanceId) throw leaseError("workspace_lease_not_owned", lease);
        const now = this._nowMs();
        if (Date.parse(lease.expiresAt) <= now) throw leaseError("workspace_lease_expired", lease);
        lease.renewedAt = new Date(now).toISOString();
        lease.expiresAt = new Date(now + Math.max(1_000, Number(ttlMs) || this.defaultTtlMs)).toISOString();
        await this._saveUnlocked();
        return structuredClone(lease);
      });
    });
  }

  release({ workspace, leaseId, runId } = {}) {
    const hash = workspaceHash(workspace);
    const id = leaseId == null ? "" : safeId(leaseId, "id");
    const run = runId == null ? "" : safeId(runId, "run_id");
    return this._serialize(async () => {
      return this._withFileLock(async () => {
        const state = await this._loadUnlocked({ fresh: true });
        const lease = state.leases[hash];
        if (!lease) return false;
        if ((id && lease.id !== id) || (run && lease.runId !== run) || lease.ownerInstanceId !== this.instanceId) {
          throw leaseError("workspace_lease_not_owned", lease);
        }
        delete state.leases[hash];
        await this._saveUnlocked();
        return true;
      });
    });
  }

  resolveQuarantine({ workspace, runId, resolutionMarker } = {}) {
    const hash = workspaceHash(workspace);
    const run = safeId(runId, "run_id");
    if (!this.isVerifiedResolution(resolutionMarker)) {
      return Promise.reject(leaseError("workspace_write_outcome_uncertain"));
    }
    return this._serialize(async () => this._withFileLock(async () => {
      const state = await this._loadUnlocked({ fresh: true });
      const lease = state.leases[hash];
      if (!lease) return false;
      if (lease.runId !== run || lease.quarantined !== true) throw leaseError("workspace_lease_held", lease);
      delete state.leases[hash];
      await this._saveUnlocked();
      return true;
    }));
  }

  async get(workspace) {
    await this.tail;
    const state = await this._loadUnlocked({ fresh: true });
    const lease = state.leases[workspaceHash(workspace)];
    return lease ? structuredClone(lease) : null;
  }

  async list() {
    await this.tail;
    const state = await this._loadUnlocked({ fresh: true });
    return Object.values(state.leases).map((lease) => structuredClone(lease));
  }

  recoverStale({ activeRunIds = [], assumeSingleProcess = true } = {}) {
    const active = new Set(activeRunIds.map((id) => safeId(id, "run_id")));
    return this._serialize(async () => {
      return this._withFileLock(async () => {
        const state = await this._loadUnlocked({ fresh: true });
        const now = this._nowMs();
        const removed = [];
        let changed = false;
        for (const [hash, lease] of Object.entries(state.leases)) {
          const expired = Date.parse(lease.expiresAt) <= now;
          const protectedRun = active.has(lease.runId);
          if (protectedRun && assumeSingleProcess && lease.ownerInstanceId !== this.instanceId) {
            if (lease.quarantined !== true) {
              lease.quarantined = true;
              changed = true;
            }
            continue;
          }
          const crashedOwner = assumeSingleProcess && lease.ownerInstanceId !== this.instanceId && !protectedRun;
          if (!expired && !crashedOwner) continue;
          removed.push(structuredClone(lease));
          delete state.leases[hash];
          changed = true;
        }
        if (changed) await this._saveUnlocked();
        return removed;
      });
    });
  }

  async flush() {
    await this.tail;
  }
}

export { SCHEMA_VERSION as WORKSPACE_LEASE_SCHEMA_VERSION, workspaceHash as hashWorkspacePath };
