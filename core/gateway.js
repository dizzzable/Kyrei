import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile, mkdir, readdir, stat, rename, rm, realpath, open as openFile } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { SessionStore } from "./session-store.js";
import { SkillsStore } from "./skills-store.js";
import { CronStore } from "./cron-store.js";
import { CronScheduler } from "./cron-scheduler.js";
import { TeamRunStore } from "./team-run-store.js";
import { PipelineRunStore } from "./pipeline-run-store.js";
import { PipelineMissionRunner } from "./pipeline-mission-runner.js";
import { WorkspaceLeaseStore } from "./workspace-lease-store.js";
import { observeWorkspace } from "./workspace-evidence.js";
import { redactSensitiveText, redactSensitiveValue } from "./secret-redaction.js";
import {
  TeamConfigError,
  normalizeOrchestration,
  validateOrchestrationInput,
} from "./team-config.js";
import {
  PipelineConfigError,
  normalizePipelines,
  validatePipelinesInput,
} from "./pipeline-config.js";
import { ProviderDiscoveryError, discoverProviderModels } from "./provider-discovery.js";
import { publicProviderTemplates } from "./provider-templates.js";
import { ProviderAccountPoolRouter } from "./provider-account-pool.js";
import { KiroCliConnector } from "./kiro-cli-connector.js";
import { createKiroConnectorApi } from "./kiro-connector-api.js";
import {
  ProviderConfigError,
  collectProviderCredentialValues,
  createProviderAccountId,
  deleteProviderAccountCredentials,
  getProviderAccountCredentials,
  getActiveProvider,
  hasReadyProviderCredentials,
  hasStoredProviderCredentials,
  normalizeGatewayConfig,
  normalizeProviderAccountPool,
  normalizeProviderSecret,
  normalizeProviderSecrets,
  publicGatewayConfig,
  readyProviderAccounts,
  removeProvider,
  resolveProviderModel,
  selectProviderModel,
  setProviderAccountCredentials,
  upsertProvider,
  validateProviderAccountInput,
  validateProviderModelId,
  validateProviderPoolInput,
  validateProviderInput,
} from "./provider-config.js";

/**
 * Kyrei gateway — local HTTP server that the renderer talks to.
 *
 * Transport: Server-Sent Events for the model event stream (one subscription
 * per session) + plain JSON POST for commands. No external deps, works over
 * the Electron renderer's fetch/EventSource.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /api/status                     -> runtime + provider summary (no secrets)
 *   GET  /api/config                     -> { provider, model, workspace, hasKey }
 *   PUT  /api/config                     -> set provider/apiKey/model/workspace
 *   POST /api/choose-folder              -> { folder } (native picker)
 *   GET  /api/sessions                   -> { sessions }
 *   POST /api/sessions                   -> create -> { id }
 *   GET  /api/sessions/:id/messages      -> { messages }
 *   PATCH  /api/sessions/:id             -> rename { title }
 *   DELETE /api/sessions/:id             -> remove
 *   GET  /api/events?session=<id>        -> SSE event stream for a session
 *   GET  /api/team-runs/:runId           -> redacted durable Team event ledger
 *   GET  /api/pipelines                  -> public Pipeline v1 definitions
 *   PUT  /api/pipelines                  -> atomically validate/save definitions
 *   GET  /api/pipeline-runs              -> durable organization missions
 *   POST /api/pipeline-runs              -> create a pinned mission
 *   GET  /api/pipeline-runs/:id          -> mission snapshot
 *   POST /api/pipeline-runs/:id/*        -> start/pause/resume/cancel/approval/attach-session/artifact
 *   POST /api/prompt   { session, text, modelParams? } -> run a turn (emits over SSE)
 *   POST /api/cancel   { session }       -> cancel the running turn
 */

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Kyrei-Gateway-Token",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(res.kyreiCors ?? {}) });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", chunk => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > 20_000_000) {
        settled = true;
        const error = new Error("request_body_too_large");
        error.code = "request_body_too_large";
        reject(error);
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        settled = true;
        const raw = Buffer.concat(chunks, size).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error("invalid_json");
        error.code = "invalid_json";
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function providerCredentialScope(provider) {
  try {
    return `${provider.protocol}:${new URL(provider.baseURL).origin}:${provider.requiresApiKey ? "explicit" : "none"}`;
  } catch {
    return `${provider.protocol}:invalid:${provider.requiresApiKey ? "explicit" : "none"}`;
  }
}

function collectRuntimeSensitiveValues(configState, secretState) {
  return collectProviderCredentialValues(secretState, configState?.providers);
}

function pruneProviderAccountSecrets(secretState, providers) {
  const next = normalizeProviderSecrets(secretState);
  const providerById = new Map((Array.isArray(providers) ? providers : []).map((provider) => [provider.id, provider]));
  next.providers = Object.fromEntries(
    Object.entries(next.providers).filter(([providerId]) => providerById.has(providerId)),
  );
  next.accounts = Object.fromEntries(Object.entries(next.accounts).flatMap(([providerId, accounts]) => {
    const provider = providerById.get(providerId);
    if (!provider) return [];
    const allowedIds = new Set(
      normalizeProviderAccountPool(provider.accountPool, provider.models).members
        .filter((member) => member.id !== "primary")
        .map((member) => member.id),
    );
    const retained = Object.fromEntries(
      Object.entries(accounts).filter(([accountId]) => allowedIds.has(accountId)),
    );
    return Object.keys(retained).length ? [[providerId, retained]] : [];
  }));
  return next;
}

function sameModelEndpoint(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function providerIsReady(provider, secretState) {
  return Boolean(provider?.enabled && hasReadyProviderCredentials(provider, secretState));
}

function requireReadyProviderModel(configState, secretState, providerId, modelId, options) {
  const target = resolveProviderModel(configState, providerId, modelId, options);
  if (!providerIsReady(target.provider, secretState)) {
    throw new ProviderConfigError("provider_credentials_required");
  }
  const hasEligibleAccount = readyProviderAccounts(target.provider, secretState).some((account) => (
    !Object.hasOwn(account, "modelIds") || account.modelIds.includes(target.model.id)
  ));
  if (!hasEligibleAccount) throw new ProviderConfigError("provider_accounts_unavailable");
  return target;
}

function selectExistingProviderModel(configState, providerId, modelId) {
  const target = resolveProviderModel(configState, providerId, validateProviderModelId(modelId));
  return normalizeGatewayConfig({
    ...configState,
    activeProviderId: target.provider.id,
    activeModelId: target.model.id,
  });
}

function applyModelAssignments(configState, requestedAssignments) {
  if (!requestedAssignments || typeof requestedAssignments !== "object" || Array.isArray(requestedAssignments)) {
    throw new ProviderConfigError("provider_selection_invalid");
  }
  const resolveAssignment = (assignment) => {
    if (
      typeof assignment !== "object" || assignment === null || Array.isArray(assignment) ||
      typeof assignment.providerId !== "string" || !assignment.providerId.trim() ||
      typeof assignment.modelId !== "string" || !assignment.modelId.trim()
    ) {
      throw new ProviderConfigError("provider_selection_invalid");
    }
    const target = resolveProviderModel(configState, assignment.providerId.trim(), assignment.modelId.trim());
    return { providerId: target.provider.id, modelId: target.model.id };
  };
  const worker = requestedAssignments.worker == null
    ? undefined
    : resolveAssignment(requestedAssignments.worker);
  if (requestedAssignments.fallbacks != null && !Array.isArray(requestedAssignments.fallbacks)) {
    throw new ProviderConfigError("provider_selection_invalid");
  }
  const seen = new Set();
  const fallbacks = (requestedAssignments.fallbacks ?? []).slice(0, 16).map(resolveAssignment).filter((assignment) => {
    const key = `${assignment.providerId}\0${assignment.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return normalizeGatewayConfig({
    ...configState,
    modelAssignments: { ...(worker ? { worker } : {}), fallbacks },
  });
}

function reconcileReadyModelAssignments(configState, secretState) {
  const worker = configState.modelAssignments?.worker;
  const readyWorker = (() => {
    if (!worker) return undefined;
    try {
      requireReadyProviderModel(configState, secretState, worker.providerId, worker.modelId);
      return worker;
    } catch {
      return undefined;
    }
  })();
  const readyFallbacks = (configState.modelAssignments?.fallbacks ?? []).filter((fallback) => {
    try {
      requireReadyProviderModel(configState, secretState, fallback.providerId, fallback.modelId);
      return true;
    } catch {
      return false;
    }
  });
  const unchanged = readyWorker === worker
    && readyFallbacks.length === (configState.modelAssignments?.fallbacks ?? []).length;
  if (unchanged) return configState;
  return normalizeGatewayConfig({
    ...configState,
    modelAssignments: { ...(readyWorker ? { worker: readyWorker } : {}), fallbacks: readyFallbacks },
  });
}

function reconcileReadyDefault(configState, secretState) {
  try {
    requireReadyProviderModel(
      configState,
      secretState,
      configState.activeProviderId,
      configState.activeModelId,
    );
    return configState;
  } catch {
    // Prefer another eligible model on the current provider before moving to
    // the remaining providers in their stable registry order. Never rewrite
    // account model rules to manufacture a fallback.
  }
  const active = configState.providers.find((provider) => provider.id === configState.activeProviderId);
  const providers = [
    ...(active?.enabled ? [active] : []),
    ...configState.providers.filter((provider) => provider.enabled && provider.id !== active?.id),
  ];
  for (const provider of providers) {
    for (const model of provider.models) {
      try {
        requireReadyProviderModel(configState, secretState, provider.id, model.id);
        return normalizeGatewayConfig({
          ...configState,
          activeProviderId: provider.id,
          activeModelId: model.id,
        });
      } catch {
        // Continue through the deterministic provider/model order.
      }
    }
  }
  return configState;
}

function activeOrchestrationProfile(configState) {
  const orchestration = configState.orchestration;
  if (!orchestration || orchestration.defaultMode === "single") return null;
  return orchestration.profiles?.find(
    (profile) => profile.id === orchestration.activeProfileId && profile.enabled,
  ) ?? null;
}

/**
 * Active Team profiles are executable configuration, not merely UI presets.
 * Resolve every target at the save boundary so a missing credential cannot
 * turn into a late worker failure after the acting model has already started.
 */
function requireReadyActiveOrchestration(configState, secretState) {
  const orchestration = configState.orchestration;
  if (!orchestration || orchestration.defaultMode === "single") return null;
  const profile = activeOrchestrationProfile(configState);
  if (!profile) throw new TeamConfigError("orchestration_active_profile_invalid");

  // The acting model always remains the session/default model, even when every
  // worker has an explicit target.
  requireReadyProviderModel(
    configState,
    secretState,
    configState.activeProviderId,
    configState.activeModelId,
  );
  for (const role of profile.roles) {
    if (!role.model) continue;
    requireReadyProviderModel(
      configState,
      secretState,
      role.model.providerId,
      role.model.modelId,
    );
  }
  return profile;
}

/** Keep saved profiles editable, but fail closed to Single when a live target disappears. */
function reconcileReadyOrchestration(configState, secretState) {
  try {
    requireReadyActiveOrchestration(configState, secretState);
    return configState;
  } catch {
    return {
      ...configState,
      orchestration: normalizeOrchestration({
        ...configState.orchestration,
        defaultMode: "single",
      }, configState.providers),
    };
  }
}

function reconcileReadyRuntimeConfig(configState, secretState) {
  let nextConfig = reconcileReadyDefault(configState, secretState);
  nextConfig = reconcileReadyModelAssignments(nextConfig, secretState);
  nextConfig = reconcileReadyOrchestration(nextConfig, secretState);
  return nextConfig;
}

function publicCronJob(job) {
  if (!job) return null;
  const { expression, lastRunAt, lastRunStatus, lastScheduledAt, nextRunAt, ...rest } = job;
  return {
    ...rest,
    schedule: expression,
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(lastRunStatus ? { lastRunStatus } : {}),
    ...(lastScheduledAt ? { lastScheduledAt } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  };
}

function publicCronRun(run) {
  if (!run) return null;
  const status = run.status === "success"
    ? "complete"
    : run.status === "error"
      ? "failed"
      : run.status === "cancelled"
        ? "interrupted"
        : "running";
  const { finishedAt, sessionId, scheduledFor, dueAt, result, error, ...rest } = run;
  return {
    ...rest,
    status,
    ...(finishedAt ? { finishedAt } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

export function requestErrorStatus(error) {
  const code = typeof error?.code === "string"
    ? error.code
    : typeof error?.message === "string"
      ? error.message
      : "";
  if (code === "invalid_json") return 400;
  if (code === "request_body_too_large") return 413;
  if (code === "secret_storage_unavailable") return 503;
  if (code === "provider_discovery_unauthorized") return 401;
  if (code === "provider_discovery_target_blocked") return 403;
  if (code === "provider_discovery_rate_limited") return 429;
  if (code === "provider_discovery_timeout") return 504;
  if (code === "provider_discovery_unavailable" || code === "provider_discovery_invalid_response" || code === "provider_discovery_response_too_large") return 502;
  if (code === "kiro_cli_login_not_found") return 404;
  if (code === "kiro_cli_auth_busy" || code === "kiro_cli_login_active") return 409;
  if (code === "kiro_cli_timeout" || code === "kiro_cli_login_timeout") return 504;
  if (
    code === "kiro_cli_not_found"
    || code === "kiro_cli_connector_closed"
    || code === "kiro_cli_connector_quarantined"
    || code === "kiro_cli_resolver_failed"
  ) return 503;
  if (
    code === "kiro_cli_start_failed"
    || code === "kiro_cli_command_failed"
    || code === "kiro_cli_output_limit"
    || code.startsWith("kiro_cli_model_")
    || code.startsWith("kiro_cli_models_")
  ) return 502;
  if (code.startsWith("kiro_cli_")) return 400;
  if (code.endsWith("_not_found") || code.endsWith("-not-found")) return 404;
  if (code.endsWith("_state_corrupt") || code.endsWith("_state_invalid") || code.endsWith("_journal_corrupt")) return 500;
  if (code.endsWith("_store_busy") || code.endsWith("_lock_busy")) return 503;
  if (
    code === "skill_exists"
    || code === "root_overlap"
    || code.endsWith("_conflict")
    || code.endsWith("-conflict")
    || code.endsWith("_exists")
    || code.endsWith("_held")
    || code.endsWith("_not_owned")
    || code.endsWith("_transition_invalid")
    || code.endsWith("_resume_invalid")
    || code.endsWith("_outcome_uncertain")
    || code === "pipeline_runtime_changed"
    || code === "pipeline_write_resolution_required"
    || code === "pipeline_write_resolution_stale"
    || code === "pipeline_write_resolution_unverified"
    || code === "pipeline_write_outcome_unverifiable"
    || code === "pipeline_workspace_changed"
    || code === "pipeline_runtime_unavailable"
    || code === "sandbox_required_unavailable"
    || code === "pipeline_run_terminal"
    || code === "pipeline_stage_active"
    || code === "pipeline_stage_run_inactive"
    || code === "pipeline_stage_retry_exhausted"
    || code === "pipeline_stage_dependencies_incomplete"
    || code === "pipeline_completion_gate_failed"
    || code === "provider_primary_account_required"
    || code === "provider_account_limit_reached"
  ) return 409;
  if (
    code.startsWith("pipeline_")
    || code.startsWith("workspace_lease_")
  ) return 400;
  if (error?.name === "SkillsStoreError" || error?.name === "ProviderConfigError" || error?.name === "ProviderDiscoveryError" || error?.name === "TeamConfigError" || error?.name === "PipelineConfigError" || error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.keys(nested).sort().map((key) => [key, nested[key]]),
    );
  });
}

function digestJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function referencedProfilesForDefinition(definition, teamProfiles = []) {
  const referencedIds = [...new Set(
    (Array.isArray(definition?.stages) ? definition.stages : [])
      .map((stage) => stage?.teamProfileId)
      .filter((id) => typeof id === "string" && id),
  )].sort();
  const profilesById = new Map(
    (Array.isArray(teamProfiles) ? teamProfiles : []).map((profile) => [profile.id, profile]),
  );
  return referencedIds.map((id) => profilesById.get(id) ?? { id, missing: true });
}

function pipelineRuntimeIdentity(definition, teamProfiles = [], runtimeDependencies = {}) {
  const referencedProfiles = referencedProfilesForDefinition(definition, teamProfiles);
  const definitionDigest = digestJson(definition);
  return {
    definitionDigest,
    runtimeFingerprint: digestJson({
      version: 1,
      definitionDigest,
      referencedProfiles,
      runtimeDependencies,
    }),
  };
}

async function trustedRuntimeBinary(candidates) {
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0) continue;
      const content = await readFile(path);
      return {
        path,
        digest: createHash("sha256").update(content).digest("hex"),
      };
    } catch {
      // Try the next immutable system location.
    }
  }
  return null;
}

const sandboxProbeCache = new Map();

function runPinnedProbe(command, args, timeoutMs = 3_000) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "" },
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function probeSandboxPrimitive(primitive, platform = process.platform) {
  const cacheKey = `${platform}:${primitive.path}:${primitive.digest}`;
  if (sandboxProbeCache.has(cacheKey)) return sandboxProbeCache.get(cacheKey);
  const result = platform === "linux"
    ? runPinnedProbe(primitive.path, [
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-net",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--proc", "/proc",
      "--dev", "/dev",
      "--dir", "/tmp",
      "--chdir", "/tmp",
      "--die-with-parent",
      "--", "/bin/true",
    ])
    : platform === "darwin"
      ? runPinnedProbe(primitive.path, ["-p", "(version 1) (allow default)", "/usr/bin/true"])
      : Promise.resolve(false);
  sandboxProbeCache.set(cacheKey, result);
  return result;
}

async function pipelineSandboxCapability(engine = {}) {
  const mode = engine?.sandbox ?? "off";
  if (mode === "off") return { mode, id: "noop", available: true };
  let primitive = null;
  if (process.platform === "linux") {
    primitive = await trustedRuntimeBinary(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]);
  } else if (process.platform === "darwin" && mode !== "strict-required") {
    primitive = await trustedRuntimeBinary(["/usr/bin/sandbox-exec"]);
  }
  if (primitive && !(await probeSandboxPrimitive(primitive))) primitive = null;
  const capability = {
    mode,
    id: process.platform === "linux" ? "bwrap" : process.platform === "darwin" ? "sandbox-exec" : "unavailable",
    available: Boolean(primitive),
    ...(primitive ?? {}),
  };
  if (mode === "strict-required" && !capability.available) {
    const error = new Error("sandbox_required_unavailable");
    error.code = "sandbox_required_unavailable";
    throw error;
  }
  return capability;
}

function advancePipelines(input, current, teamProfiles) {
  const expectedGeneration = input?.generation ?? 0;
  if (expectedGeneration !== current.generation) {
    throw new PipelineConfigError("pipeline_revision_conflict");
  }
  const validated = validatePipelinesInput(input, teamProfiles);
  const currentById = new Map(current.definitions.map((definition) => [definition.id, definition]));
  for (const definition of validated.definitions) {
    const previous = currentById.get(definition.id);
    if (!previous) {
      if (definition.revision !== 1) throw new PipelineConfigError("pipeline_definition_revision_invalid");
      continue;
    }
    const comparable = { ...definition, revision: previous.revision };
    const changed = canonicalJson(comparable) !== canonicalJson(previous);
    const requiredRevision = changed ? previous.revision + 1 : previous.revision;
    if (definition.revision !== requiredRevision) {
      throw new PipelineConfigError("pipeline_definition_revision_conflict");
    }
  }
  return { ...validated, generation: current.generation + 1 };
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("operation-aborted");
  error.name = "AbortError";
  throw error;
}

function requireWriteResolutionMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pipeline_write_resolution_invalid");
  }
  const outcome = typeof value.outcome === "string" ? value.outcome : "";
  const workspaceDigest = typeof value.workspaceDigest === "string" ? value.workspaceDigest.toLowerCase() : "";
  const observedAt = typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt))
    ? new Date(value.observedAt).toISOString()
    : "";
  if (!new Set(["retry", "applied", "abandoned"]).has(outcome) || !/^[a-f0-9]{64}$/.test(workspaceDigest) || !observedAt) {
    throw new TypeError("pipeline_write_resolution_invalid");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 32) {
    throw new TypeError("pipeline_write_resolution_invalid");
  }
  const evidence = value.evidence.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("pipeline_write_resolution_invalid");
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    const digest = typeof entry.digest === "string" ? entry.digest.toLowerCase() : "";
    if (!new Set(["workspace", "diff", "file", "command", "test"]).has(type) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new TypeError("pipeline_write_resolution_invalid");
    }
    return { type, digest };
  });
  const note = typeof value.note === "string" ? value.note.trim().slice(0, 2_000) : "";
  return { outcome, workspaceDigest, observedAt, evidence, ...(note ? { note } : {}) };
}

function pipelineConflict(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateEngineConfigBoundary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("engine_config_invalid");
  }
  if (
    Object.hasOwn(value, "sandbox")
    && !new Set(["off", "strict", "strict-required"]).has(value.sandbox)
  ) {
    throw new TypeError("engine_sandbox_invalid");
  }
  return value;
}

async function verifyWriteResolutionMarker(marker, run, stage) {
  const now = Date.now();
  const operatorObservedAt = Date.parse(marker.observedAt);
  const interruptedAt = Math.max(
    Date.parse(run.interruption?.at ?? "") || 0,
    Date.parse(stage.finishedAt ?? "") || 0,
  );
  if (
    operatorObservedAt > now + 60_000
    || now - operatorObservedAt > 15 * 60_000
    || (interruptedAt && operatorObservedAt < interruptedAt)
  ) {
    throw pipelineConflict("pipeline_write_resolution_stale");
  }
  const observation = await observeWorkspace(run.workspace);
  const hasWorkspaceReceipt = marker.evidence.some(
    (entry) => entry.type === "workspace" && entry.digest === observation.digest,
  );
  if (marker.workspaceDigest !== observation.digest || !hasWorkspaceReceipt) {
    throw pipelineConflict("pipeline_write_resolution_unverified");
  }
  if (marker.outcome === "retry" && stage.workspaceDigestBefore !== observation.digest) {
    throw pipelineConflict("pipeline_write_outcome_uncertain");
  }
  // Phase 1 has no signed Action Executor receipt or action-specific
  // postcondition verifier, so accepting "applied" would turn a human claim
  // into workspace truth. Fail closed until that receipt exists.
  if (marker.outcome === "applied") {
    throw pipelineConflict("pipeline_write_outcome_unverifiable");
  }
  return {
    ...marker,
    operatorObservedAt: marker.observedAt,
    workspaceDigest: observation.digest,
    observedAt: observation.observedAt,
    evidence: [
      ...marker.evidence.filter((entry) => entry.type !== "workspace"),
      { type: "workspace", digest: observation.digest },
    ],
    verification: {
      verifier: "kyrei-gateway",
      version: 1,
      algorithm: observation.algorithm,
      observedAt: observation.observedAt,
      entries: observation.entries,
      bytes: observation.bytes,
      excluded: observation.excluded,
    },
  };
}

async function persistedResolutionStillValid(run, stage) {
  const marker = stage?.resolution?.marker;
  if (!marker || typeof marker !== "object" || !new Set(["retry", "abandoned"]).has(marker.outcome)) {
    return null;
  }
  const observation = await observeWorkspace(run.workspace).catch(() => null);
  if (!observation || observation.digest !== marker.workspaceDigest) return null;
  if (marker.outcome === "retry" && stage.workspaceDigestBefore !== observation.digest) return null;
  return marker;
}

function resolutionRequestMatchesPersisted(supplied, persisted) {
  if (!supplied || !persisted || typeof persisted !== "object") return false;
  const comparableEvidence = (entries) => (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.type !== "workspace")
    .map((entry) => ({ type: entry.type, digest: entry.digest }))
    .sort((left, right) => `${left.type}:${left.digest}`.localeCompare(`${right.type}:${right.digest}`));
  return supplied.outcome === persisted.outcome
    && supplied.workspaceDigest === persisted.workspaceDigest
    && supplied.observedAt === persisted.operatorObservedAt
    && canonicalJson(comparableEvidence(supplied.evidence)) === canonicalJson(comparableEvidence(persisted.evidence));
}

const PERSISTENCE_META = "__kyreiPersistence";
const PERSISTENCE_SNAPSHOT_DIR = ".kyrei-provider-state";

class SecretStorageUnavailableError extends Error {
  constructor() {
    super("OS secret storage is unavailable");
    this.name = "SecretStorageUnavailableError";
    this.code = "secret_storage_unavailable";
  }
}

function persistenceRevision(value) {
  const revision = value?.[PERSISTENCE_META]?.revision;
  return typeof revision === "string" && /^[a-z0-9-]+$/.test(revision) ? revision : "";
}

function persistedValue(value, revision) {
  const snapshot = JSON.parse(JSON.stringify(value ?? {}));
  return {
    ...snapshot,
    [PERSISTENCE_META]: { version: 1, revision },
  };
}

/**
 * Crash-resilient persistence for the provider registry and its secret sidecar.
 *
 * Each call snapshots its inputs synchronously, then joins a FIFO write queue.
 * The main pair is committed secrets-first/config-second with atomic renames.
 * A revisioned recovery pair is recorded only after both main files commit, so
 * a rejected save can never become the authoritative state after a restart.
 */
export function createGatewayConfigPersistence({ dataDir, secretsCodec, requireProtectedSecrets = false, fileSystem = {} }) {
  const fs = {
    chmod,
    readFile,
    writeFile,
    mkdir,
    readdir,
    stat,
    rename,
    rm,
    open: openFile,
    ...fileSystem,
  };
  const configPath = join(dataDir, "kyrei-config.json");
  const secretsPath = join(dataDir, "kyrei-secrets.json");
  const snapshotDir = join(dataDir, PERSISTENCE_SNAPSHOT_DIR);
  let writeTail = Promise.resolve();
  let revisionSequence = 0;
  const hasSecretMaterial = (value) => {
    const normalized = normalizeProviderSecrets(value);
    return Object.keys(normalized.providers).length > 0 || Object.keys(normalized.accounts).length > 0;
  };

  const nextRevision = () => [
    Date.now().toString(36),
    (++revisionSequence).toString(36).padStart(6, "0"),
    randomBytes(6).toString("hex"),
  ].join("-");

  const atomicWrite = async (target, content, { secret = false } = {}) => {
    const temp = join(
      target.slice(0, target.length - basename(target).length),
      `.${basename(target)}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(temp, content, {
        encoding: "utf8",
        flag: "wx",
        ...(secret ? { mode: 0o600 } : {}),
      });
      if (secret && process.platform !== "win32") await fs.chmod(temp, 0o600);
      const fileHandle = await fs.open(temp, "r+");
      try {
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await fs.rename(temp, target);
      // `mode` only applies at creation time. Reassert the final Unix mode
      // after every rename; packaged builds additionally use safeStorage.
      if (secret && process.platform !== "win32") await fs.chmod(target, 0o600);
      if (process.platform !== "win32") {
        const directoryHandle = await fs.open(dirname(target), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  };

  const decodeSecrets = async (raw) => {
    const envelope = JSON.parse(raw);
    if (envelope?.protection !== "electron-safe-storage") {
      if (requireProtectedSecrets && !secretsCodec && hasSecretMaterial(envelope)) {
        throw new SecretStorageUnavailableError();
      }
      return { value: envelope, revision: persistenceRevision(envelope) };
    }
    if (!secretsCodec || typeof envelope.payload !== "string") {
      throw new SecretStorageUnavailableError();
    }
    const decoded = JSON.parse(await secretsCodec.decode(envelope.payload));
    return {
      value: decoded,
      revision: persistenceRevision(envelope) || persistenceRevision(decoded),
    };
  };

  const encodeSecrets = async (snapshot, revision) => {
    const persisted = persistedValue(snapshot, revision);
    const plain = JSON.stringify(persisted, null, 2);
    if (!secretsCodec) {
      if (requireProtectedSecrets && hasSecretMaterial(snapshot)) throw new SecretStorageUnavailableError();
      return plain;
    }
    return JSON.stringify({
      version: 2,
      protection: "electron-safe-storage",
      revision,
      [PERSISTENCE_META]: { version: 1, revision },
      payload: await secretsCodec.encode(plain),
    }, null, 2);
  };

  const cleanupTemps = async () => {
    const directories = [dataDir, snapshotDir];
    for (const directory of directories) {
      let names = [];
      try {
        names = await fs.readdir(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const name of names) {
        const isMainTemp = directory === dataDir && /^\.kyrei-(?:config|secrets)\.json\..+\.tmp$/.test(name);
        const isSnapshotTemp = directory === snapshotDir && /^\.(?:config|secrets)-[a-z0-9-]+\.json\..+\.tmp$/.test(name);
        if (isMainTemp || isSnapshotTemp) await fs.rm(join(directory, name), { force: true }).catch(() => {});
      }
    }
  };

  const snapshotPairs = async () => {
    let names = [];
    try {
      names = await fs.readdir(snapshotDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const configs = new Map();
    const secrets = new Map();
    for (const name of names) {
      const match = name.match(/^(config|secrets)-([a-z0-9-]+)\.json$/);
      if (!match) continue;
      (match[1] === "config" ? configs : secrets).set(match[2], name);
    }
    const pairs = [];
    for (const [revision, configName] of configs) {
      const secretsName = secrets.get(revision);
      if (!secretsName) continue;
      const configFile = join(snapshotDir, configName);
      const secretsFile = join(snapshotDir, secretsName);
      let modified = 0;
      try {
        const [configInfo, secretsInfo] = await Promise.all([fs.stat(configFile), fs.stat(secretsFile)]);
        modified = Math.max(configInfo.mtimeMs, secretsInfo.mtimeMs);
      } catch {
        continue;
      }
      pairs.push({ revision, configFile, secretsFile, modified });
    }
    return pairs.sort((left, right) => right.modified - left.modified || right.revision.localeCompare(left.revision));
  };

  const loadPair = async (configFile, secretsFile, expectedRevision = "") => {
    const [rawConfig, rawSecrets] = await Promise.all([
      fs.readFile(configFile, "utf8"),
      fs.readFile(secretsFile, "utf8"),
    ]);
    const parsedSecrets = await decodeSecrets(rawSecrets);
    const parsedConfig = JSON.parse(rawConfig);
    const configRevision = persistenceRevision(parsedConfig);
    const secretsRevision = parsedSecrets.revision;
    const revisionsMatch = expectedRevision
      ? configRevision === expectedRevision && secretsRevision === expectedRevision
      : configRevision === secretsRevision || (!configRevision && !secretsRevision);
    if (!revisionsMatch) throw new Error("provider-persistence-revision-mismatch");
    return { config: parsedConfig, secrets: parsedSecrets.value };
  };

  const load = async () => {
    await fs.mkdir(snapshotDir, { recursive: true });
    await cleanupTemps();
    try {
      return await loadPair(configPath, secretsPath);
    } catch (error) {
      // A readable encrypted envelope proves that this store is protected.
      // Never fall back to an older plaintext generation when safeStorage is
      // unavailable, because that would silently downgrade secret protection.
      if (error instanceof SecretStorageUnavailableError) throw error;
    }
    const pairs = await snapshotPairs();
    for (const pair of pairs) {
      try {
        return await loadPair(pair.configFile, pair.secretsFile, pair.revision);
      } catch (error) {
        if (error instanceof SecretStorageUnavailableError) throw error;
      }
    }

    // No consistent pair exists (first run or unrecoverable corruption). Keep a
    // valid public config when possible, but never combine it with unverified
    // credentials from another revision.
    let fallbackConfig = {};
    try { fallbackConfig = JSON.parse(await fs.readFile(configPath, "utf8")); } catch { /* first run/corrupt config */ }
    return { config: fallbackConfig, secrets: {} };
  };

  const pruneSnapshots = async currentRevision => {
    let names = [];
    try { names = await fs.readdir(snapshotDir); } catch { return; }
    for (const name of names) {
      const match = name.match(/^(?:config|secrets)-([a-z0-9-]+)\.json$/);
      // One last-known-good pair is enough for half-commit recovery. Retaining
      // older revisions would keep explicitly cleared credentials alive.
      if (match && match[1] !== currentRevision) {
        await fs.rm(join(snapshotDir, name), { force: true }).catch(() => {});
      }
    }
  };

  const purgeSnapshots = async () => {
    let names = [];
    try { names = await fs.readdir(snapshotDir); } catch { return; }
    await Promise.all(names.map(name => {
      if (!/^(?:config|secrets)-[a-z0-9-]+\.json$/.test(name)) return Promise.resolve();
      return fs.rm(join(snapshotDir, name), { force: true }).catch(() => {});
    }));
  };

  const commit = async ({ revision, configSnapshot, secretsSnapshot }) => {
    await fs.mkdir(snapshotDir, { recursive: true });
    const configStored = JSON.stringify(persistedValue(configSnapshot, revision), null, 2);
    const secretsStored = await encodeSecrets(secretsSnapshot, revision);

    // Main state is the commit point. A crash between these two renames leaves
    // different revisions, which load() rejects in favour of a prior snapshot.
    await atomicWrite(secretsPath, secretsStored, { secret: true });
    await atomicWrite(configPath, configStored);

    // Recovery snapshots are written after the main pair commits. Failure to
    // refresh redundancy must not make an already committed save look rejected.
    const snapshotSecrets = join(snapshotDir, `secrets-${revision}.json`);
    const snapshotConfig = join(snapshotDir, `config-${revision}.json`);
    try {
      await atomicWrite(snapshotSecrets, secretsStored, { secret: true });
      await atomicWrite(snapshotConfig, configStored);
      await pruneSnapshots(revision);
    } catch {
      await Promise.all([
        fs.rm(snapshotSecrets, { force: true }).catch(() => {}),
        fs.rm(snapshotConfig, { force: true }).catch(() => {}),
      ]);
      // Main files already committed. If redundancy cannot be refreshed, a
      // stale snapshot is less safe than no snapshot because it could retain
      // credentials the user just cleared and resurrect them on recovery.
      await purgeSnapshots();
    }
    return revision;
  };

  const save = (configValue, secretsValue) => {
    // JSON round-tripping happens before the promise is queued: callers may
    // safely mutate their working objects immediately after save() returns.
    const job = {
      revision: nextRevision(),
      configSnapshot: JSON.parse(JSON.stringify(configValue ?? {})),
      secretsSnapshot: JSON.parse(JSON.stringify(secretsValue ?? {})),
    };
    const result = writeTail.then(() => commit(job));
    writeTail = result.catch(() => {});
    return result;
  };

  return {
    configPath,
    secretsPath,
    snapshotDir,
    load,
    save,
    drain: () => writeTail,
  };
}

export async function startGateway({
  dataDir,
  chooseFolder,
  preferredPort = 8765,
  authToken,
  rendererOrigin = "null",
  secretsCodec,
  requireProtectedSecrets = false,
  openPath,
  kiroConnector = new KiroCliConnector(),
  engineLoader = () => import("./engine/.dist/index.mjs"),
  providerDiscovery = discoverProviderModels,
  sandboxCapabilityProbe = pipelineSandboxCapability,
  runtimeBuildId = process.env.KYREI_BUILD_ID ?? process.env.npm_package_version ?? "development",
} = {}) {
  if (typeof engineLoader !== "function") throw new TypeError("engine-loader-required");
  if (typeof providerDiscovery !== "function") throw new TypeError("provider-discovery-required");
  if (typeof sandboxCapabilityProbe !== "function") throw new TypeError("sandbox-capability-probe-required");
  const kiroApi = createKiroConnectorApi(kiroConnector);
  // The local port is not an authentication boundary: any web page can target
  // loopback. Every API request carries this per-launch capability token.
  const gatewayToken = typeof authToken === "string" && authToken.length >= 32
    ? authToken
    : randomBytes(32).toString("base64url");

  const tokenMatches = (candidate) => {
    if (typeof candidate !== "string") return false;
    const actual = Buffer.from(candidate);
    const expected = Buffer.from(gatewayToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const isLoopbackHost = (host) => /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(host ?? ""));
  // Chromium normally serializes file origins as `null`; accept `file://` as
  // well for platform variants. Both still require the launch capability.
  const allowedOrigins = new Set(rendererOrigin === "null" ? ["null", "file://"] : [rendererOrigin]);
  const isExpectedOrigin = (origin) => !origin || allowedOrigins.has(origin);
  const corsFor = (origin) => allowedOrigins.has(origin)
    ? { ...CORS_BASE, "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
  await mkdir(dataDir, { recursive: true });
  const persistence = createGatewayConfigPersistence({ dataDir, secretsCodec, requireProtectedSecrets });
  let loaded;
  try {
    loaded = await persistence.load();
  } catch (error) {
    throw new Error(`Kyrei could not unlock the provider secret store: ${error.message}`);
  }
  const rawConfig = loaded.config;
  let config = normalizeGatewayConfig(rawConfig);
  let secrets = pruneProviderAccountSecrets(normalizeProviderSecrets(loaded.secrets), config.providers);
  const legacyApiKey = typeof rawConfig.apiKey === "string" ? rawConfig.apiKey : "";
  if (legacyApiKey && !secrets.providers[config.activeProviderId]?.apiKey) {
    secrets.providers[config.activeProviderId] = {
      ...(secrets.providers[config.activeProviderId] ?? {}),
      apiKey: legacyApiKey,
    };
  }
  config = reconcileReadyRuntimeConfig(config, secrets);
  const saveConfig = (configValue = config, secretsValue = secrets) => persistence.save(configValue, secretsValue);
  await saveConfig(config, secrets);

  let configMutationTail = Promise.resolve();
  const mutateConfig = operation => {
    const result = configMutationTail.then(operation);
    configMutationTail = result.catch(() => {});
    return result;
  };

  const store = new SessionStore({ runtimeDir: dataDir });
  await store.load();
  const runtimeSensitiveValuesFor = (configState = config, secretState = secrets) => (
    collectRuntimeSensitiveValues(configState, secretState)
  );
  const runtimeSensitiveValues = () => runtimeSensitiveValuesFor(config, secrets);
  const resolutionReceiptRegistry = new WeakSet();
  const isVerifiedResolution = (marker) => Boolean(marker && typeof marker === "object" && resolutionReceiptRegistry.has(marker));
  const teamRunStore = new TeamRunStore({ dataDir, getSensitiveValues: runtimeSensitiveValues });
  await teamRunStore.recoverInterrupted().catch(() => []);
  const pipelineRunStore = new PipelineRunStore({ dataDir, getSensitiveValues: runtimeSensitiveValues, isVerifiedResolution });
  await pipelineRunStore.recoverInterrupted();
  const workspaceLeaseStore = new WorkspaceLeaseStore({ dataDir, getSensitiveValues: runtimeSensitiveValues, isVerifiedResolution });
  // The gateway is a single local process. A lease owned by an older instance
  // can be released after the mission is first marked interrupted/uncertain;
  // the run store still requires explicit write-outcome resolution before any
  // resume, so cleanup cannot cause a blind duplicate write.
  const recoveredPipelineRuns = await pipelineRunStore.list();
  const leaseProtectedRunIds = recoveredPipelineRuns
    .filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
    .map((run) => run.runId);
  await workspaceLeaseStore.recoverStale({
    assumeSingleProcess: true,
    activeRunIds: leaseProtectedRunIds,
  });
  const recoveredRunsById = new Map(recoveredPipelineRuns.map((run) => [run.runId, run]));
  for (const lease of await workspaceLeaseStore.list()) {
    if (lease.quarantined !== true) continue;
    const run = recoveredRunsById.get(lease.runId);
    const stage = run?.stages.find((candidate) => candidate.id === lease.stageId);
    const persistedMarker = run && stage ? await persistedResolutionStillValid(run, stage) : null;
    if (!persistedMarker) continue;
    resolutionReceiptRegistry.add(persistedMarker);
    await workspaceLeaseStore.resolveQuarantine({
      workspace: run.workspace,
      runId: run.runId,
      resolutionMarker: persistedMarker,
    });
  }
  const skillsStore = new SkillsStore({ dataDir });
  await skillsStore.load();
  if (config.workspace) await skillsStore.setWorkspace(config.workspace).catch(() => {});
  const buildPipelineRuntimeIdentity = async (definition, configSnapshot = config, secretsSnapshot = secrets) => {
    const profiles = referencedProfilesForDefinition(definition, configSnapshot.orchestration.profiles);
    if (profiles.some((profile) => profile.missing === true || profile.enabled !== true)) {
      throw pipelineConflict("pipeline_runtime_unavailable");
    }
    const skillIds = [...new Set(profiles.flatMap((profile) => (
      Array.isArray(profile.roles) ? profile.roles.flatMap((role) => role.skillIds ?? []) : []
    )))].sort();
    const skills = await Promise.all(skillIds.map(async (id) => {
      try {
        const skill = await skillsStore.get(id);
        return {
          id,
          enabled: skill.enabled,
          digest: digestJson({ metadata: skill.metadata, content: skill.content }),
        };
      } catch {
        return { id, missing: true };
      }
    }));
    const effectiveTargets = profiles.flatMap((profile) => (
      Array.isArray(profile.roles)
        ? profile.roles.map((role) => ({
          profileId: profile.id,
          roleId: role.id,
          providerId: role.model?.providerId ?? configSnapshot.activeProviderId,
          modelId: role.model?.modelId ?? configSnapshot.activeModelId,
          source: role.model ? "role" : "default",
        }))
        : []
    ));
    const actingTarget = {
      providerId: configSnapshot.activeProviderId,
      modelId: configSnapshot.activeModelId,
    };
    const providerIds = [...new Set([
      actingTarget.providerId,
      ...effectiveTargets.map((target) => target.providerId),
    ].filter(Boolean))].sort();
    const providersById = new Map(configSnapshot.providers.map((provider) => [provider.id, provider]));
    const providers = providerIds.map((id) => {
      const provider = providersById.get(id);
      if (!provider) return { id, missing: true };
      const pool = normalizeProviderAccountPool(provider.accountPool, provider.models);
      const readyAccountIds = new Set(readyProviderAccounts(provider, secretsSnapshot).map((account) => account.id));
      return {
        id,
        protocol: provider.protocol,
        baseURL: provider.baseURL,
        enabled: provider.enabled,
        ready: providerIsReady(provider, secretsSnapshot),
        requiresApiKey: provider.requiresApiKey,
        headersDigest: digestJson(provider.headers ?? {}),
        models: provider.models,
        accountPool: {
          enabled: pool.enabled,
          strategy: pool.strategy,
          sessionAffinity: pool.sessionAffinity,
          members: pool.members.map((member) => ({
            id: member.id,
            enabled: member.enabled,
            weight: member.weight,
            priority: member.priority,
            maxConcurrency: member.maxConcurrency,
            ready: readyAccountIds.has(member.id),
            ...(Object.hasOwn(member, "modelIds") ? { modelIds: member.modelIds } : {}),
          })),
        },
      };
    });
    const providerRuntimeById = new Map(providers.map((provider) => [provider.id, provider]));
    const unavailableTarget = [actingTarget, ...effectiveTargets].some((target) => {
      const provider = providerRuntimeById.get(target.providerId);
      return !provider
        || provider.missing === true
        || provider.ready !== true
        || !Array.isArray(provider.models)
        || !provider.models.some((model) => model.id === target.modelId)
        || !provider.accountPool.members.some((member) => (
          member.ready === true
          && (!Object.hasOwn(member, "modelIds") || member.modelIds.includes(target.modelId))
        ));
    });
    if (unavailableTarget || skills.some((skill) => skill.missing === true || skill.enabled !== true)) {
      throw pipelineConflict("pipeline_runtime_unavailable");
    }
    const sandbox = await sandboxCapabilityProbe(configSnapshot.engine ?? {}, configSnapshot.workspace);
    if ((configSnapshot.engine?.sandbox ?? "off") === "strict-required" && sandbox?.available !== true) {
      throw pipelineConflict("sandbox_required_unavailable");
    }
    return pipelineRuntimeIdentity(definition, configSnapshot.orchestration.profiles, {
      providers,
      actingTarget,
      effectiveTargets,
      skills,
      engine: configSnapshot.engine ?? {},
      sandbox,
      runtimeBuildId: String(runtimeBuildId),
      engineContractVersion: 1,
      pipelineRuntimeVersion: 1,
      platform: process.platform,
      architecture: process.arch,
    });
  };
  const assertPipelineRuntimeCurrent = async (run, configSnapshot = config, secretsSnapshot = secrets) => {
    const definition = configSnapshot.pipelines.definitions.find(
      (candidate) => candidate.id === run.pipelineId && candidate.enabled,
    );
    const identity = definition ? await buildPipelineRuntimeIdentity(definition, configSnapshot, secretsSnapshot) : null;
    if (
      !definition
      || String(definition.revision) !== run.definitionRevision
      || identity.definitionDigest !== run.definitionDigest
      || identity.runtimeFingerprint !== run.runtimeFingerprint
    ) {
      const error = new Error("pipeline_runtime_changed");
      error.code = "pipeline_runtime_changed";
      throw error;
    }
  };
  const assertWorkspaceCheckpointCurrent = async (run) => {
    const observation = await observeWorkspace(run.workspace);
    if (observation.digest !== run.workspaceCheckpointDigest) {
      throw pipelineConflict("pipeline_workspace_changed");
    }
    return observation;
  };
  const cronStore = new CronStore({ dataDir });
  await cronStore.load();
  const gatewayStartedAt = new Date();

  // SSE subscribers + per-session AbortControllers, keyed by session id.
  const subscribers = new Map(); // sessionId -> Set<res>
  const controllers = new Map(); // sessionId -> AbortController
  const runtimeStatus = new Map(); // sessionId -> "working" (absent = idle)
  const activePromptProviders = new Map(); // sessionId -> provider ids whose credentials may be in flight
  const subagentRuns = new Map(); // subagentId -> cross-session runtime summary
  const shutdownController = new AbortController();

  // The engine is a built ESM bundle, loaded lazily on first prompt.
  let engine = null;
  const getEngine = async () => {
    if (!engine) engine = await engineLoader();
    return engine;
  };

  function trackSubagentEvent(sessionId, event) {
    if (!event?.type?.startsWith("subagent.")) return;
    const payload = event.payload ?? {};
    const id = typeof payload.subagent_id === "string" ? payload.subagent_id : "";
    if (!id) return;
    const now = Date.now();
    const previous = subagentRuns.get(id);
    const status = event.type === "subagent.complete"
      ? "completed"
      : event.type === "subagent.failed"
        ? payload.status === "interrupted" ? "interrupted" : "failed"
        : "running";
    subagentRuns.set(id, {
      id,
      parentId: payload.parent_id ?? undefined,
      sessionId,
      goal: payload.goal ?? previous?.goal ?? "",
      model: payload.model ?? previous?.model,
      status,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      durationSeconds: payload.duration_seconds ?? previous?.durationSeconds,
      inputTokens: payload.input_tokens ?? previous?.inputTokens,
      outputTokens: payload.output_tokens ?? previous?.outputTokens,
      toolCount: payload.tool_count ?? previous?.toolCount,
      filesRead: payload.files_read ?? previous?.filesRead ?? [],
      filesWritten: payload.files_written ?? previous?.filesWritten ?? [],
      currentTool: payload.current_tool ?? previous?.currentTool,
      summary: payload.summary ?? previous?.summary,
      error: payload.error ?? previous?.error,
    });
    if (subagentRuns.size > 200) {
      const oldest = [...subagentRuns.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (oldest) subagentRuns.delete(oldest.id);
    }
  }

  function publicRuntimeEvent(event, sensitiveValues = runtimeSensitiveValues()) {
    return redactSensitiveValue(event, sensitiveValues, {
      maxDepth: 12,
      maxStringChars: 8_000,
      maxArrayItems: 200,
      maxObjectKeys: 200,
    });
  }

  function writePublicEvent(sessionId, publicEvent) {
    const set = subscribers.get(sessionId);
    if (!set) return;
    const frame = `data: ${JSON.stringify(publicEvent)}\n\n`;
    for (const res of set) { try { res.write(frame); } catch { /* dropped */ } }
  }

  function emitTo(sessionId, event) {
    const publicEvent = publicRuntimeEvent(event);
    trackSubagentEvent(sessionId, publicEvent);
    const runId = publicEvent?.payload?.run_id;
    if (typeof runId === "string" && runId) {
      void teamRunStore.append(runId, publicEvent).catch(() => undefined);
    }
    writePublicEvent(sessionId, publicEvent);
  }

  /** Broadcast one persisted Team event to every session attached to a mission. */
  function emitPipelineTeamEvent(run, event, sensitiveValues) {
    const publicEvent = publicRuntimeEvent(event, sensitiveValues);
    trackSubagentEvent(`pipeline:${run.runId}`, publicEvent);
    const teamRunId = publicEvent?.payload?.run_id;
    if (typeof teamRunId === "string" && teamRunId) {
      void teamRunStore.append(teamRunId, publicEvent).catch(() => undefined);
    }
    for (const sessionId of run.attachedSessionIds ?? []) writePublicEvent(sessionId, publicEvent);
  }

  function publicConfig() {
    // `engine` tuning is non-secret (permissions/roles/budgets), so it is safe
    // to echo back for the settings Advanced pane. The apiKey is never exposed —
    // only `hasKey`.
    return publicGatewayConfig(config, secrets);
  }

  const accountPoolRouters = new Map();
  const providerRuntimeGenerations = new Map();

  function providerRuntimeGeneration(providerId) {
    return providerRuntimeGenerations.get(providerId) ?? 0;
  }

  function providerRuntimeAbortReason() {
    const error = new Error("provider_runtime_changed");
    error.name = "AbortError";
    return error;
  }

  function invalidateProviderRuntime(providerId) {
    providerRuntimeGenerations.set(providerId, providerRuntimeGeneration(providerId) + 1);
    accountPoolRouters.delete(providerId);
    for (const [sessionId, providerIds] of activePromptProviders) {
      if (providerIds.has(providerId)) controllers.get(sessionId)?.abort(providerRuntimeAbortReason());
    }
    // Pipeline departments can use several role providers. Their durable
    // runtime fingerprint fences late results; abort them eagerly as well so a
    // revoked credential is not kept alive until the next checkpoint.
    for (const controller of pipelineAdvanceControllers.values()) {
      if (!controller.signal.aborted) controller.abort(providerRuntimeAbortReason());
    }
  }

  function invalidateAllProviderRuntimes(providerIds = []) {
    const known = [
      ...providerIds,
      ...providerRuntimeGenerations.keys(),
      ...config.providers.map((provider) => provider.id),
      ...[...activePromptProviders.values()].flatMap((ids) => [...ids]),
    ];
    for (const providerId of new Set(known)) invalidateProviderRuntime(providerId);
  }

  function accountPoolRouterFor(provider, secretState = secrets) {
    const pool = normalizeProviderAccountPool(provider.accountPool, provider.models);
    const readyIds = new Set(readyProviderAccounts(provider, secretState).map((account) => account.id));
    const members = pool.members.map((member) => ({
      ...member,
      status: readyIds.has(member.id) ? "ready" : "auth-required",
    }));
    const fingerprint = JSON.stringify({
      enabled: pool.enabled,
      strategy: pool.strategy,
      sessionAffinity: pool.sessionAffinity,
      members,
    });
    const current = accountPoolRouters.get(provider.id);
    if (current?.fingerprint === fingerprint) return current.router;
    const router = new ProviderAccountPoolRouter({
      // The gateway already reduces a disabled pool to its legacy primary
      // member. Keeping the domain router enabled gives that member the same
      // capacity/health accounting as an enabled multi-account pool.
      config: {
        enabled: true,
        strategy: pool.strategy,
        sessionAffinity: pool.sessionAffinity,
        members: pool.enabled ? members : members.filter((member) => member.id === "primary"),
      },
    });
    accountPoolRouters.set(provider.id, { fingerprint, router });
    return router;
  }

  function providerAttemptLifecycleFor({
    configState = config,
    secretState = secrets,
    generationSnapshot = new Map(
      configState.providers.map((provider) => [provider.id, providerRuntimeGeneration(provider.id)]),
    ),
    sessionId,
    preferredProviderId,
    preferredAccountId,
    signal,
  } = {}) {
    return {
      acquire(target) {
        // The legacy single-credential path has no account-pool capacity to
        // reserve. Provider mutation is still fenced by the shared abort signal.
        if (!target?.accountId) return { legacy: true };
        if (signal?.aborted) return null;
        if (generationSnapshot.get(target.providerId) !== providerRuntimeGeneration(target.providerId)) {
          return null;
        }
        const provider = configState.providers.find((candidate) => candidate.id === target.providerId);
        if (!provider) return null;
        const memberExists = normalizeProviderAccountPool(provider.accountPool, provider.models).members.some(
          (member) => member.id === target.accountId,
        );
        if (!memberExists) return null;
        const router = accountPoolRouterFor(provider, secretState);
        const lease = router.acquire({
          sessionId,
          preferredAccountId: target.providerId === preferredProviderId ? preferredAccountId : undefined,
          accountId: target.accountId,
          modelId: target.model ?? target.modelId,
        });
        return lease ? {
          legacy: false,
          providerId: target.providerId,
          accountId: target.accountId,
          generation: providerRuntimeGeneration(target.providerId),
          router,
          lease,
        } : null;
      },
      release(handle, outcome) {
        if (!handle || handle.legacy) return;
        handle.router.release(handle.lease);
        if (handle.generation !== providerRuntimeGeneration(handle.providerId)) return;
        if (outcome?.outcome === "success") {
          handle.router.reportSuccess(handle.accountId, { sessionId });
          return;
        }
        if (outcome?.outcome === "retryable-error" || outcome?.outcome === "terminal-error") {
          handle.router.reportFailure(handle.accountId, {
            statusCode: outcome.statusCode,
            retryAfterMs: outcome.retryAfterMs,
            retryable: outcome.outcome === "retryable-error",
          });
        }
      },
    };
  }

  function publicProviderAccountPool(providerId) {
    const provider = config.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new ProviderConfigError("provider_not_found");
    const pool = normalizeProviderAccountPool(provider.accountPool, provider.models);
    const publicProvider = publicConfig().providers.find((candidate) => candidate.id === providerId);
    const runtimeById = new Map(accountPoolRouterFor(provider).listMembers().map((member) => [member.id, member]));
    return {
      providerId,
      pool: {
        enabled: pool.enabled,
        strategy: pool.strategy,
        sessionAffinity: pool.sessionAffinity,
      },
      accounts: (publicProvider?.accountPool?.members ?? []).map((member) => {
        const runtime = runtimeById.get(member.id);
        return {
          ...member,
          ...(runtime ?? {}),
          status: runtime?.status ?? (!member.enabled ? "disabled" : member.ready ? "ready" : "auth-required"),
          cooldownUntil: runtime?.cooldownUntil ?? 0,
          inflight: runtime?.inflight ?? 0,
        };
      }),
    };
  }

  function privateRuntimeTargetsForConfig(
    configState,
    secretState,
    providerId,
    modelId,
    { fallbackToDefault = false, sessionId, preferredAccountId, routingKey } = {},
  ) {
    const { provider, model } = requireReadyProviderModel(
      configState,
      secretState,
      providerId,
      modelId,
      { fallbackToDefault },
    );
    const router = accountPoolRouterFor(provider, secretState);
    const poolEnabled = normalizeProviderAccountPool(provider.accountPool, provider.models).enabled;
    const ordered = router.orderedCandidates({
      sessionId: routingKey ?? sessionId,
      preferredAccountId,
      modelId: model.id,
    });
    if (!ordered.length) throw new ProviderConfigError("provider_accounts_unavailable");
    return ordered.map((account) => {
      const credentials = provider.requiresApiKey
        ? getProviderAccountCredentials(secretState, provider.id, account.id)
        : {};
      return {
        providerId: provider.id,
        ...(poolEnabled ? { accountId: account.id } : {}),
        protocol: provider.protocol,
        baseURL: provider.baseURL,
        model: model.id,
        apiKey: provider.requiresApiKey ? credentials.apiKey ?? "" : "",
        credentials,
        ...(provider.headers ? { headers: provider.headers } : {}),
        requiresApiKey: provider.requiresApiKey,
      };
    });
  }

  function privateRuntimeTargetForConfig(
    configState,
    secretState,
    providerId,
    modelId,
    options = {},
  ) {
    const targets = privateRuntimeTargetsForConfig(
      configState,
      secretState,
      providerId,
      modelId,
      options,
    );
    const selected = targets[0];
    if (options.routingKey && selected?.accountId) {
      const provider = configState.providers.find((candidate) => candidate.id === selected.providerId);
      const router = provider ? accountPoolRouterFor(provider, secretState) : null;
      const lease = router?.acquire({
        sessionId: options.routingKey,
        preferredAccountId: options.preferredAccountId,
        accountId: selected.accountId,
        modelId: selected.model,
      });
      if (lease) router.release(lease);
    }
    return selected;
  }

  function privateRuntimeTarget(providerId, modelId, options = {}) {
    return privateRuntimeTargetForConfig(config, secrets, providerId, modelId, options);
  }

  function workerRuntimeTarget(sessionId) {
    const worker = config.modelAssignments?.worker;
    if (!worker) return undefined;
    try {
      return privateRuntimeTargetForConfig(config, secrets, worker.providerId, worker.modelId, {
        routingKey: sessionId ? `${sessionId}:worker` : "worker",
      });
    } catch {
      return undefined;
    }
  }

  function fallbackRuntimeTargets(sessionId) {
    return (config.modelAssignments?.fallbacks ?? []).flatMap((fallback) => {
      try {
        return privateRuntimeTargetsForConfig(config, secrets, fallback.providerId, fallback.modelId, {
          routingKey: sessionId ? `${sessionId}:fallback:${fallback.providerId}:${fallback.modelId}` : undefined,
        });
      } catch {
        // Credential/provider mutations reconcile eagerly; skip a target that
        // disappeared in the narrow interval before this prompt started.
        return [];
      }
    });
  }

  function cloneRuntimeTarget(target) {
    return {
      ...target,
      ...(target.credentials ? { credentials: { ...target.credentials } } : {}),
      ...(target.headers ? { headers: { ...target.headers } } : {}),
    };
  }

  /**
   * Resolve the credential-free profile into an engine-only runtime contract.
   * Role credentials never enter public config, persistence events, or SSE.
   */
  function teamRuntimeSpecForProfile(
    profileId,
    mainTarget,
    runtimeSkills,
    configState = config,
    secretState = secrets,
    routingKeyPrefix = "team",
  ) {
    const profile = configState.orchestration?.profiles?.find(
      (candidate) => candidate.id === profileId && candidate.enabled,
    );
    if (!profile) return undefined;
    const availableSkills = new Set(
      (Array.isArray(runtimeSkills) ? runtimeSkills : [])
        .map((skill) => typeof skill?.id === "string" ? skill.id : "")
        .filter(Boolean),
    );
    try {
      const roles = profile.roles.map((role) => ({
        id: role.id,
        name: role.name,
        ...(role.description ? { description: role.description } : {}),
        ...(role.instructions ? { instructions: role.instructions } : {}),
        target: role.model
          ? privateRuntimeTargetForConfig(
              configState,
              secretState,
              role.model.providerId,
              role.model.modelId,
              { routingKey: `${routingKeyPrefix}:${profile.id}:${role.id}` },
            )
          : cloneRuntimeTarget(mainTarget),
        skillIds: role.skillIds.filter((id) => availableSkills.has(id)),
        capabilities: [...role.capabilities],
        canSpawn: role.canSpawn,
        maxChildren: role.maxChildren,
      }));
      if (!roles.length) return undefined;
      return {
        profileId: profile.id,
        name: profile.name,
        workflow: profile.workflow,
        limits: { ...profile.limits },
        roles,
      };
    } catch {
      // Configuration mutations reconcile this state eagerly. This guard also
      // closes the small race where credentials are cleared during a prompt.
      return undefined;
    }
  }

  function teamRuntimeSpec(mainTarget, runtimeSkills, sessionId) {
    const profile = activeOrchestrationProfile(config);
    return profile
      ? teamRuntimeSpecForProfile(profile.id, mainTarget, runtimeSkills, config, secrets, `session:${sessionId}`)
      : undefined;
  }

  function pipelineText(value, max = 4_000, sensitiveValues = runtimeSensitiveValues()) {
    if (typeof value !== "string") return "";
    return redactSensitiveText(value, sensitiveValues)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function pipelineTextList(value, maxItems = 64, maxText = 1_000, sensitiveValues = runtimeSensitiveValues()) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, maxItems).flatMap((item) => {
      const result = pipelineText(item, maxText, sensitiveValues);
      return result ? [result] : [];
    });
  }

  function pipelineMetric(value) {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
  }

  const MAX_PIPELINE_TOKEN_METRIC = Math.floor(Number.MAX_SAFE_INTEGER / 2);

  function addPipelineMetric(total, value, maximum = Number.MAX_SAFE_INTEGER) {
    const next = Math.min(maximum, pipelineMetric(value));
    return total >= maximum - next ? maximum : total + next;
  }

  function pipelineTeamMetrics(result, successfulTasks, startedAt) {
    const source = result?.metrics;
    const hasAggregate = source !== null && typeof source === "object" && !Array.isArray(source);
    const readInteger = (value, { required = false, minimum = 0 } = {}) => {
      if (value === undefined && !required) return 0;
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error("pipeline_department_metrics_invalid");
      }
      return value;
    };
    const readCost = (value) => {
      if (value === undefined) return 0;
      if (!Number.isFinite(value) || value < 0) throw new Error("pipeline_department_metrics_invalid");
      return value;
    };

    if (hasAggregate) {
      const inputTokens = readInteger(source.inputTokens);
      const outputTokens = readInteger(source.outputTokens);
      const providerCalls = readInteger(source.providerCalls, { required: true, minimum: 1 });
      const unmeteredProviderCalls = readInteger(source.unmeteredProviderCalls, { required: true });
      if (unmeteredProviderCalls > providerCalls) throw new Error("pipeline_department_metrics_invalid");
      if (
        source.totalTokens !== undefined
        && source.inputTokens !== undefined
        && source.outputTokens !== undefined
        && readInteger(source.totalTokens) !== inputTokens + outputTokens
      ) throw new Error("pipeline_department_metrics_invalid");
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        providerCalls,
        unmeteredProviderCalls,
        durationMs: pipelineMetric(Date.now() - startedAt),
        costUsd: readCost(source.costUsd),
      };
    }

    const inputTokens = successfulTasks.reduce(
      (total, entry) => addPipelineMetric(total, entry.artifact?.metrics?.inputTokens, MAX_PIPELINE_TOKEN_METRIC),
      0,
    );
    const outputTokens = successfulTasks.reduce(
      (total, entry) => addPipelineMetric(total, entry.artifact?.metrics?.outputTokens, MAX_PIPELINE_TOKEN_METRIC),
      0,
    );
    const providerCalls = successfulTasks.reduce(
      (total, entry) => addPipelineMetric(total, entry.artifact?.metrics?.providerCalls ?? 1),
      0,
    );
    const unmeteredProviderCalls = successfulTasks.reduce((total, entry) => {
      const metrics = entry.artifact?.metrics;
      const calls = pipelineMetric(metrics?.providerCalls ?? 1);
      const hasUsage = Number.isSafeInteger(metrics?.inputTokens) && Number.isSafeInteger(metrics?.outputTokens);
      return addPipelineMetric(total, hasUsage ? metrics?.unmeteredProviderCalls : calls);
    }, 0);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      providerCalls,
      unmeteredProviderCalls: Math.min(providerCalls, unmeteredProviderCalls),
      durationMs: pipelineMetric(Date.now() - startedAt),
      costUsd: 0,
    };
  }

  function isPipelineText(value, max = 4_000) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= max;
  }

  function isPipelineTextList(value, maxItems = 64, maxText = 4_000) {
    return Array.isArray(value)
      && value.length <= maxItems
      && value.every((item) => isPipelineText(item, maxText));
  }

  function isStructuredPipelineTeamArtifact(value) {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && isPipelineText(value.taskId, 160)
      && isPipelineText(value.summary, 4_000)
      && Number.isFinite(value.confidence)
      && value.confidence >= 0
      && value.confidence <= 1
      && isPipelineTextList(value.provenance, 48, 1_000)
      && isPipelineTextList(value.evidence, 48, 1_000)
      && isPipelineTextList(value.validation, 48, 1_000)
      && isPipelineTextList(value.uncertainties, 48, 1_000)
      && isPipelineTextList(value.whatWasNotChecked, 48, 1_000);
  }

  function isStructuredPipelineTeamResult(value) {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && isPipelineText(value.runId, 512)
      && isStructuredPipelineTeamArtifact(value.artifact)
      && Array.isArray(value.taskResults)
      && value.taskResults.length > 0
      && value.taskResults.length <= 256
      && value.taskResults.some((task) => (
        task !== null
        && typeof task === "object"
        && !Array.isArray(task)
        && task.status === "succeeded"
        && isStructuredPipelineTeamArtifact(task.artifact)
      ));
  }

  function departmentInputArtifacts(dependencyArtifacts) {
    if (!dependencyArtifacts || typeof dependencyArtifacts !== "object") return [];
    return Object.values(dependencyArtifacts).flatMap((value) => Array.isArray(value) ? value : []);
  }

  /** Convert only compact, structured Team output into a durable envelope. */
  function pipelineDepartmentArtifact({ run, stage, team, result, dependencyArtifacts, startedAt, sensitiveValues }) {
    if (!isStructuredPipelineTeamResult(result)) {
      throw new Error("pipeline_department_artifact_invalid");
    }
    const source = result?.artifact;
    const summary = pipelineText(source.summary, 8_000, sensitiveValues);
    if (!summary) throw new Error("pipeline_department_artifact_invalid");
    const capturedAt = new Date().toISOString();
    const reported = [
      ...pipelineTextList(source.evidence, 48, 1_000, sensitiveValues).map((value) => ({ category: "evidence", value })),
      ...pipelineTextList(source.validation, 32, 1_000, sensitiveValues).map((value) => ({ category: "validation", value })),
      ...pipelineTextList(source.provenance, 24, 1_000, sensitiveValues).map((value) => ({ category: "provenance", value })),
    ].slice(0, 96);
    const evidence = reported.map((item, index) => ({
      id: `team-${index + 1}`,
      kind: "diagnostic",
      origin: "reported",
      summary: `${item.category}: ${item.value}`,
      capturedAt,
      tool: "team-department",
      // Digest the redacted, persisted representation rather than a raw model
      // response. A model report never becomes trusted workspace evidence.
      outputDigest: digestJson(item),
    }));
    const successfulTasks = Array.isArray(result?.taskResults)
      ? result.taskResults.filter((entry) => entry?.status === "succeeded" && entry?.artifact)
      : [];
    const budgetMetrics = pipelineTeamMetrics(result, successfulTasks, startedAt);
    const inputs = departmentInputArtifacts(dependencyArtifacts);
    const artifact = {
      schemaVersion: 1,
      id: `department:${run.runId}:${stage.id}:${randomBytes(18).toString("hex")}`.slice(0, 512),
      kind: "department",
      runId: run.runId,
      stageId: stage.id,
      producerId: `team:${team.profileId}`.slice(0, 512),
      createdAt: capturedAt,
      summary,
      workspaceDigest: run.workspaceCheckpointDigest,
      inputDigests: [...new Set(inputs.map((artifact) => digestJson(artifact)))].slice(0, 2_000),
      assumptions: [],
      uncertainties: pipelineTextList(source.uncertainties, 96, 1_000, sensitiveValues),
      unchecked: pipelineTextList(source.whatWasNotChecked, 96, 1_000, sensitiveValues),
      provenance: {
        providerId: `team:${team.profileId}`.slice(0, 512),
        modelId: "multi-provider",
        policyDigest: run.runtimeFingerprint,
      },
      metrics: {
        inputTokens: budgetMetrics.inputTokens,
        outputTokens: budgetMetrics.outputTokens,
        totalTokens: budgetMetrics.totalTokens,
        providerCalls: budgetMetrics.providerCalls,
        durationMs: budgetMetrics.durationMs,
      },
      claims: [],
      evidence,
      checks: [],
      contradictions: [],
    };
    return { artifact, budgetMetrics };
  }

  function runtimeSkillsForEngine(runtimeSkills) {
    return (Array.isArray(runtimeSkills) ? runtimeSkills : []).flatMap((skill) => {
      if (!skill || typeof skill.id !== "string" || typeof skill.name !== "string") return [];
      return [{
        id: skill.id,
        name: skill.name,
        description: typeof skill.description === "string" ? skill.description : "",
        provenance: skill.provenance === "workspace"
          ? "project"
          : ["global", "project", "custom"].includes(skill.provenance)
            ? skill.provenance
            : "custom",
        content: typeof skill.content === "string" ? skill.content : "",
      }];
    });
  }

  function sanitizePipelineError(error, sensitiveValues, startedAt) {
    const message = error instanceof Error ? error.message : String(error ?? "pipeline_department_failed");
    const redacted = redactSensitiveText(message, sensitiveValues).slice(0, 4_000);
    const safe = new Error(redacted || "pipeline_department_failed");
    safe.name = error instanceof Error ? error.name : "Error";
    if (error && typeof error === "object" && typeof error.code === "string") safe.code = error.code;
    if (error && typeof error === "object" && error.metrics !== undefined) {
      safe.budgetMetrics = pipelineTeamMetrics({ metrics: error.metrics }, [], startedAt);
    }
    return safe;
  }

  async function executePipelineDepartment({ run, stage, dependencyArtifacts, signal }) {
    if (stage?.kind !== "department" || typeof stage.teamProfileId !== "string") {
      throw new Error("pipeline_department_stage_invalid");
    }
    const configSnapshot = structuredClone(config);
    const secretsSnapshot = structuredClone(secrets);
    const runtimeGenerationSnapshot = new Map(
      configSnapshot.providers.map((provider) => [provider.id, providerRuntimeGeneration(provider.id)]),
    );
    const sensitiveValues = runtimeSensitiveValuesFor(configSnapshot, secretsSnapshot);
    const pipelineSessionId = run.attachedSessionIds?.[0] ?? `pipeline:${run.runId}`;
    const startedAt = Date.now();
    try {
      await Promise.all([
        assertPipelineRuntimeCurrent(run, configSnapshot, secretsSnapshot),
        assertWorkspaceCheckpointCurrent(run),
      ]);
      throwIfAborted(signal ?? new AbortController().signal);
      const mainTarget = privateRuntimeTargetForConfig(
        configSnapshot,
        secretsSnapshot,
        configSnapshot.activeProviderId,
        configSnapshot.activeModelId,
      );
      const runtimeSkills = await skillsStore.runtimeSkills();
      const team = teamRuntimeSpecForProfile(
        stage.teamProfileId,
        mainTarget,
        runtimeSkills.skills,
        configSnapshot,
        secretsSnapshot,
        `pipeline:${run.runId}:${stage.id}`,
      );
      if (!team) throw new Error("pipeline_department_team_unavailable");
      const mod = await getEngine();
      if (typeof mod?.runTeamDepartment !== "function") {
        throw new Error("department_executor_unavailable");
      }
      const providerAttemptLifecycle = providerAttemptLifecycleFor({
        configState: configSnapshot,
        secretState: secretsSnapshot,
        generationSnapshot: runtimeGenerationSnapshot,
        sessionId: pipelineSessionId,
        signal,
      });
      const result = await mod.runTeamDepartment({
        team,
        goal: run.goal,
        stageId: stage.id,
        workspace: run.workspace,
        auditLogPath: join(dataDir, "audit.jsonl"),
        sessionId: pipelineSessionId,
        config: configSnapshot.engine,
        skills: runtimeSkillsForEngine(runtimeSkills.skills),
        dependencyArtifacts: departmentInputArtifacts(dependencyArtifacts),
        sensitiveValues,
        abortSignal: signal,
        providerAttemptLifecycle,
        emit: (event) => emitPipelineTeamEvent(run, event, sensitiveValues),
        onSkillUsed: (id) => skillsStore.recordUsage(id).then(() => undefined).catch(() => undefined),
      });
      // The provider call may take minutes. Do not turn an answer produced for
      // a stale configuration or workspace into a durable mission hand-off.
      throwIfAborted(signal ?? new AbortController().signal);
      await Promise.all([
        assertPipelineRuntimeCurrent(run),
        assertWorkspaceCheckpointCurrent(run),
      ]);
      throwIfAborted(signal ?? new AbortController().signal);
      return pipelineDepartmentArtifact({
        run,
        stage,
        team,
        result,
        dependencyArtifacts,
        startedAt,
        sensitiveValues,
      });
    } catch (error) {
      throw sanitizePipelineError(error, sensitiveValues, startedAt);
    }
  }

  const pipelineAdvances = new Map();
  const pipelineAdvanceControllers = new Map();
  const pipelineMissionRunner = new PipelineMissionRunner({
    runStore: pipelineRunStore,
    workspaceLeaseStore,
    executeDepartment: executePipelineDepartment,
  });

  function schedulePipelineAdvance(runId) {
    const existing = pipelineAdvances.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    pipelineAdvanceControllers.set(runId, controller);
    const task = (async () => {
      return pipelineMissionRunner.advance(runId, { signal: controller.signal });
    })().catch((error) => {
      if (controller.signal.aborted) return null;
      console.warn("[kyrei] pipeline advance failed:", error);
      return null;
    }).finally(() => {
      if (pipelineAdvances.get(runId) === task) pipelineAdvances.delete(runId);
      if (pipelineAdvanceControllers.get(runId) === controller) pipelineAdvanceControllers.delete(runId);
    });
    pipelineAdvances.set(runId, task);
    return task;
  }

  function abortPipelineAdvance(runId, reason) {
    const controller = pipelineAdvanceControllers.get(runId);
    if (!controller || controller.signal.aborted) return;
    controller.abort(new Error(reason));
  }

  async function interruptActivePipelineStage(runId, reason) {
    abortPipelineAdvance(runId, reason);
    const current = await pipelineRunStore.load(runId);
    if (!current || current.status !== "running") return current;
    const active = current.stages.filter((stage) => stage.status === "running");
    for (const stage of active) {
      // The store deliberately converts an interrupted write to uncertain;
      // read-only departments become retryable only after an explicit resume.
      await pipelineRunStore.updateStage(runId, stage.id, {
        status: "interrupted",
        error: { code: reason },
      });
    }
    return pipelineRunStore.load(runId);
  }

  function convoFor(sessionId) {
    return store.getMessages(sessionId)
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));
  }

  function createSession({ title = "", source = "chat" } = {}) {
    const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    return store.upsertSession({
      id,
      title,
      source,
      providerId: config.activeProviderId,
      modelId: config.activeModelId,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function runPrompt(sessionId, text, modelParams) {
    if (shutdownController.signal.aborted) {
      return { status: "cancelled", sessionId, error: "gateway-shutdown" };
    }
    const session = store.getSession(sessionId);
    if (!session) return { status: "error", sessionId, error: "session-not-found" };
    if (controllers.has(sessionId)) return { status: "error", sessionId, error: "session_busy" };

    const runtimeGenerationSnapshot = new Map(
      config.providers.map((provider) => [provider.id, providerRuntimeGeneration(provider.id)]),
    );

    const safePromptText = redactSensitiveText(text, runtimeSensitiveValues());
    store.appendMessage(sessionId, { role: "user", content: safePromptText });
    if (!session.title) {
      store.upsertSession({
        id: sessionId,
        title: safePromptText.slice(0, 48) + (safePromptText.length > 48 ? "…" : ""),
        updatedAt: new Date().toISOString(),
      });
      emitTo(sessionId, { type: "session.title", payload: { session_id: sessionId, title: store.getSession(sessionId).title } });
    }

    let mainTarget;
    let mainTargets = [];
    try {
      mainTargets = privateRuntimeTargetsForConfig(
        config,
        secrets,
        session.providerId,
        session.modelId,
        {
          fallbackToDefault: true,
          sessionId,
          preferredAccountId: session.providerAccountId,
        },
      );
      mainTarget = mainTargets[0];
    } catch {
      emitTo(sessionId, { type: "error", payload: { code: "provider_not_configured" } });
      emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "error" } });
      return { status: "error", sessionId, error: "provider_not_configured" };
    }
    if (session.providerId !== mainTarget.providerId || session.modelId !== mainTarget.model) {
      store.upsertSession({
        id: sessionId,
        providerId: mainTarget.providerId,
        modelId: mainTarget.model,
        ...(session.providerId !== mainTarget.providerId ? { providerAccountId: undefined } : {}),
        updatedAt: new Date().toISOString(),
      });
      emitTo(sessionId, {
        type: "session.model",
        payload: {
          session_id: sessionId,
          provider_id: mainTarget.providerId,
          model_id: mainTarget.model,
        },
      });
    }

    const controller = new AbortController();
    const abortForShutdown = () => controller.abort();
    shutdownController.signal.addEventListener("abort", abortForShutdown, { once: true });
    if (shutdownController.signal.aborted) controller.abort();
    controllers.set(sessionId, controller);
    activePromptProviders.set(sessionId, new Set(config.providers.map((provider) => provider.id)));
    runtimeStatus.set(sessionId, "working");

    try {
      const runtimeSkills = await skillsStore.runtimeSkills().catch(() => ({ skills: [] }));
      throwIfAborted(controller.signal);
      const workerProvider = workerRuntimeTarget(sessionId);
      const fallbackProviders = [
        ...mainTargets.slice(1),
        ...fallbackRuntimeTargets(sessionId),
      ];
      const team = teamRuntimeSpec(mainTarget, runtimeSkills.skills, sessionId);
      const providerAttemptLifecycle = providerAttemptLifecycleFor({
        generationSnapshot: runtimeGenerationSnapshot,
        sessionId,
        preferredProviderId: mainTarget.providerId,
        preferredAccountId: session.providerAccountId,
        signal: controller.signal,
      });
      const common = {
        emit: event => emitTo(sessionId, event),
        messages: convoFor(sessionId),
        providerBase: mainTarget.baseURL,
        providerProtocol: mainTarget.protocol,
        providerId: mainTarget.providerId,
        providerAccountId: mainTarget.accountId,
        providerHeaders: mainTarget.headers,
        requiresApiKey: mainTarget.requiresApiKey,
        apiKey: mainTarget.apiKey,
        providerCredentials: mainTarget.credentials,
        model: mainTarget.model,
        providerAttemptLifecycle,
        ...(workerProvider ? { workerProvider } : {}),
        ...(fallbackProviders.length ? { fallbackProviders } : {}),
        ...(team ? { team } : {}),
        workspace: config.workspace,
        auditLogPath: join(dataDir, "audit.jsonl"),
        sessionId,
        skills: runtimeSkills.skills.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          provenance: skill.provenance === "workspace" ? "project" : skill.provenance,
          content: skill.content ?? "",
        })),
        onSkillUsed: id => skillsStore.recordUsage(id).then(() => undefined).catch(() => undefined),
      };
      const mod = await getEngine();
      throwIfAborted(controller.signal);
      const result = await mod.runKyreiChat({
        ...common,
        abortSignal: controller.signal,
        config: config.engine,
        ...(modelParams && typeof modelParams === "object" ? { modelParams } : {}),
      });
      // A provider may resolve despite aborting its transport. Preserve the
      // shutdown boundary and never persist that late result as a success.
      throwIfAborted(controller.signal);
      const publicResult = redactSensitiveValue(result, runtimeSensitiveValues());
      const assistantText = typeof publicResult?.text === "string" ? publicResult.text : "";
      const assistantParts = Array.isArray(publicResult?.parts) ? publicResult.parts : [];
      const turnStatus = typeof result?.status === "string" ? result.status : "complete";
      const successfulTurn = turnStatus === "complete" || turnStatus === "max_steps";
      if (successfulTurn || assistantText || assistantParts.length) {
        store.appendMessage(sessionId, { role: "assistant", content: assistantText, parts: assistantParts });
      }
      const selectedAccountId = typeof result?.route?.accountId === "string" ? result.route.accountId : mainTarget.accountId;
      const selectedProviderId = typeof result?.route?.providerId === "string"
        ? result.route.providerId
        : mainTarget.providerId;
      const runtimeUnchanged = runtimeGenerationSnapshot.get(selectedProviderId) === providerRuntimeGeneration(selectedProviderId);
      const currentSelectedProvider = config.providers.find((provider) => provider.id === selectedProviderId);
      const selectedAccountIsCurrent = Boolean(
        currentSelectedProvider
        && normalizeProviderAccountPool(currentSelectedProvider.accountPool, currentSelectedProvider.models)
          .members.some((member) => member.id === selectedAccountId),
      );
      store.upsertSession({
        id: sessionId,
        ...(successfulTurn && runtimeUnchanged && selectedAccountIsCurrent && selectedAccountId && selectedProviderId === mainTarget.providerId
          ? { providerAccountId: selectedAccountId }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      if (!successfulTurn) {
        return {
          status: turnStatus === "interrupted" ? "cancelled" : "error",
          sessionId,
          error: turnStatus === "interrupted" ? "interrupted" : "provider_stream_error",
        };
      }
      return { status: "success", sessionId, summary: assistantText.slice(0, 4000) };
    } catch (err) {
      // A synchronous throw or a failed engine-bundle import must not become an
      // unhandled rejection (would crash the gateway) — surface it and end turn.
      const aborted = controller.signal.aborted || err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));
      const publicError = redactSensitiveText(err?.message || String(err), runtimeSensitiveValues());
      if (aborted) {
        emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "interrupted" } });
      } else {
        emitTo(sessionId, { type: "error", payload: { message: publicError } });
        emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "error" } });
      }
      return { status: aborted ? "cancelled" : "error", sessionId, error: publicError };
    } finally {
      shutdownController.signal.removeEventListener("abort", abortForShutdown);
      if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
      activePromptProviders.delete(sessionId);
      runtimeStatus.delete(sessionId);
    }
  }

  const cronScheduler = new CronScheduler({
    store: cronStore,
    runJob: async job => {
      const session = createSession({ title: job.name, source: "cron" });
      return runPrompt(session.id, job.prompt);
    },
  });
  cronScheduler.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    res.kyreiCors = corsFor(origin);

    // Bind only to loopback and reject spoofed browser origins before any
    // response that a page could read. The bearer token remains mandatory even
    // for file:// (Origin: null) renderers.
    if (!isLoopbackHost(req.headers.host)) return sendJson(res, 421, { error: "loopback host required" });
    if (!isExpectedOrigin(origin)) return sendJson(res, 403, { error: "unexpected origin" });
    if (req.method === "OPTIONS") {
      if (!origin) return sendJson(res, 403, { error: "origin required" });
      res.writeHead(204, res.kyreiCors);
      res.end();
      return;
    }
    const headerToken = Array.isArray(req.headers["x-kyrei-gateway-token"])
      ? req.headers["x-kyrei-gateway-token"][0]
      : req.headers["x-kyrei-gateway-token"];
    const eventToken = path === "/api/events" ? url.searchParams.get("token") : null;
    if (path !== "/health" && !tokenMatches(headerToken) && !tokenMatches(eventToken)) {
      return sendJson(res, 401, { error: "gateway authentication required" });
    }

    try {
      if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });

      if (req.method === "GET" && path === "/api/status") {
        const activeProvider = getActiveProvider(config);
        const skills = await skillsStore.list();
        const cronJobs = cronStore.list();
        const pipelineRuns = await pipelineRunStore.list();
        const nextRunAt = cronJobs
          .map(job => job.nextRunAt)
          .filter(Boolean)
          .sort()[0];
        return sendJson(res, 200, {
          ok: true,
          engine: "kyrei",
          startedAt: gatewayStartedAt.toISOString(),
          uptimeMs: Date.now() - gatewayStartedAt.getTime(),
          activeRuns: runtimeStatus.size,
          platform: process.platform,
          arch: process.arch,
          providerReady: Boolean(activeProvider && hasReadyProviderCredentials(activeProvider, secrets)),
          providerName: activeProvider?.name ?? "",
          model: config.activeModelId,
          workspace: config.workspace,
          skills: { enabled: skills.filter(skill => skill.enabled).length, total: skills.length },
          cron: {
            enabled: cronJobs.filter(job => job.enabled).length,
            total: cronJobs.length,
            ...(nextRunAt ? { nextRunAt } : {}),
          },
          pipelines: {
            active: pipelineRuns.filter((run) => !["completed", "failed", "cancelled"].includes(run.status)).length,
            total: pipelineRuns.length,
          },
          agents: [...subagentRuns.values()].sort((left, right) => right.updatedAt - left.updatedAt),
        });
      }

      const teamRunMatch = path.match(/^\/api\/team-runs\/([^/]+)$/);
      if (teamRunMatch && req.method === "GET") {
        let runId = "";
        try {
          runId = decodeURIComponent(teamRunMatch[1]).trim();
        } catch {
          throw new TypeError("team_run_id_invalid");
        }
        if (!runId || runId.length > 300 || runId.includes("\0")) {
          throw new TypeError("team_run_id_invalid");
        }
        const events = await teamRunStore.read(runId);
        if (!events.length) {
          return sendJson(res, 404, { code: "team_run_not_found", error: "team_run_not_found" });
        }
        return sendJson(res, 200, { runId, events });
      }

      if (path === "/api/config") {
        if (req.method === "GET") return sendJson(res, 200, publicConfig());
        if (req.method === "PUT") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            let nextConfig = config;
            let nextSecrets = normalizeProviderSecrets(secrets);
            const orchestrationExplicit = Object.hasOwn(body, "orchestration");
            const pipelinesExplicit = Object.hasOwn(body, "pipelines");
            const providersExplicit = Array.isArray(body.providers) && body.providers.length > 0;
            if (providersExplicit) {
            const importedProviders = [];
            const importedIds = new Set();
            for (const row of body.providers) {
              const provider = validateProviderInput(row, { creating: true });
              if (importedIds.has(provider.id)) throw new ProviderConfigError("provider_id_conflict");
              importedIds.add(provider.id);
              importedProviders.push(provider);
            }
            const previousActiveProviderId = config.activeProviderId;
            const previousActiveModelId = config.activeModelId;
            const previousProviders = new Map(config.providers.map((provider) => [provider.id, provider]));
            nextConfig = normalizeGatewayConfig({
              ...nextConfig,
              providers: importedProviders,
              activeProviderId: typeof body.activeProviderId === "string" ? body.activeProviderId : previousActiveProviderId,
              activeModelId: typeof body.activeModelId === "string" ? body.activeModelId : previousActiveModelId,
              modelAssignments: nextConfig.modelAssignments,
            });
            const nextProviders = new Map(nextConfig.providers.map((provider) => [provider.id, provider]));
            nextSecrets.providers = Object.fromEntries(
              Object.entries(nextSecrets.providers).filter(([providerId]) => {
                const previous = previousProviders.get(providerId);
                const next = nextProviders.get(providerId);
                return previous && next && providerCredentialScope(previous) === providerCredentialScope(next);
              }),
            );
            nextSecrets.accounts = Object.fromEntries(
              Object.entries(nextSecrets.accounts).filter(([providerId]) => {
                const previous = previousProviders.get(providerId);
                const next = nextProviders.get(providerId);
                return previous && next && providerCredentialScope(previous) === providerCredentialScope(next);
              }),
            );
            }
            const assignmentsExplicit = Object.hasOwn(body, "modelAssignments");
            if (assignmentsExplicit) {
              nextConfig = applyModelAssignments(nextConfig, body.modelAssignments);
            }
            const active = getActiveProvider(nextConfig);
            if (typeof body.provider === "string" && active) {
              const updated = upsertProvider(nextConfig, { ...active, baseURL: body.provider }, active.id);
              nextConfig = updated.config;
              if (providerCredentialScope(active) !== providerCredentialScope(updated.provider)) {
                delete nextSecrets.providers[active.id];
                delete nextSecrets.accounts[active.id];
              }
            }
            const selectionExplicit = Object.hasOwn(body, "activeProviderId") ||
              Object.hasOwn(body, "activeModelId") || Object.hasOwn(body, "model");
            if (
              (Object.hasOwn(body, "activeProviderId") && typeof body.activeProviderId !== "string") ||
              (Object.hasOwn(body, "activeModelId") && typeof body.activeModelId !== "string") ||
              (Object.hasOwn(body, "model") && typeof body.model !== "string")
            ) {
              throw new ProviderConfigError("provider_selection_invalid");
            }
            const requestedProviderId = typeof body.activeProviderId === "string" ? body.activeProviderId : nextConfig.activeProviderId;
            const requestedProvider = nextConfig.providers.find((provider) => provider.id === requestedProviderId && provider.enabled);
            const requestedModel = typeof body.activeModelId === "string"
              ? body.activeModelId
              : typeof body.model === "string"
                ? body.model
                : Object.hasOwn(body, "activeProviderId")
                  ? requestedProvider?.models[0]?.id
                  : nextConfig.activeModelId;
            if (selectionExplicit) {
              const legacyManualModelSelection = Object.hasOwn(body, "model") && !Object.hasOwn(body, "activeModelId");
              nextConfig = legacyManualModelSelection
                ? selectProviderModel(nextConfig, requestedProviderId || nextConfig.activeProviderId, requestedModel)
                : selectExistingProviderModel(nextConfig, requestedProviderId || nextConfig.activeProviderId, requestedModel);
            }
            if (typeof body.apiKey === "string" && body.apiKey.trim()) {
              nextSecrets.providers[nextConfig.activeProviderId] = {
                ...(nextSecrets.providers[nextConfig.activeProviderId] ?? {}),
                apiKey: body.apiKey.trim(),
              };
            }
            if (body.clearApiKey === true) delete nextSecrets.providers[nextConfig.activeProviderId];
            if (typeof body.workspace === "string") {
              nextConfig = { ...nextConfig, workspace: body.workspace };
            }
            // Engine tuning (permissions/roles/fallbackChain/budgets). Validated
            // engine-side by resolveEngineConfig (fail-open), so we store as-is.
            if (Object.hasOwn(body, "engine")) {
              nextConfig = { ...nextConfig, engine: validateEngineConfigBoundary(body.engine) };
            }
            if (orchestrationExplicit) {
              nextConfig = {
                ...nextConfig,
                orchestration: validateOrchestrationInput(body.orchestration, nextConfig.providers),
              };
            }
            if (pipelinesExplicit) {
              nextConfig = {
                ...nextConfig,
                pipelines: advancePipelines(body.pipelines, config.pipelines, nextConfig.orchestration.profiles),
              };
            } else if (orchestrationExplicit) {
              nextConfig = {
                ...nextConfig,
                pipelines: normalizePipelines(nextConfig.pipelines, nextConfig.orchestration.profiles),
              };
            }
            if (selectionExplicit) {
              requireReadyProviderModel(
                nextConfig,
                nextSecrets,
                nextConfig.activeProviderId,
                nextConfig.activeModelId,
              );
            }
            if (assignmentsExplicit && nextConfig.modelAssignments?.worker) {
              const worker = nextConfig.modelAssignments.worker;
              requireReadyProviderModel(nextConfig, nextSecrets, worker.providerId, worker.modelId);
            }
            if (assignmentsExplicit) {
              for (const fallback of nextConfig.modelAssignments?.fallbacks ?? []) {
                requireReadyProviderModel(nextConfig, nextSecrets, fallback.providerId, fallback.modelId);
              }
            }
            // Credential deletion must never be blocked. A clear request is
            // reconciled to Single below; every other Team activation must be
            // fully runnable before the atomic config save commits.
            if (orchestrationExplicit && body.clearApiKey !== true) {
              requireReadyActiveOrchestration(nextConfig, nextSecrets);
            }
            if ((body.clearApiKey === true && !selectionExplicit) || providersExplicit) {
              nextConfig = reconcileReadyDefault(nextConfig, nextSecrets);
            }
            nextConfig = reconcileReadyModelAssignments(nextConfig, nextSecrets);
            nextConfig = reconcileReadyOrchestration(nextConfig, nextSecrets);
            nextSecrets = pruneProviderAccountSecrets(nextSecrets, nextConfig.providers);
            if (typeof body.workspace === "string") await skillsStore.setWorkspace(body.workspace);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            invalidateAllProviderRuntimes();
            return publicGatewayConfig(config, secrets);
          });
          return sendJson(res, 200, snapshot);
        }
      }

      if (path === "/api/pipelines") {
        if (req.method === "GET") {
          return sendJson(res, 200, normalizePipelines(config.pipelines, config.orchestration.profiles));
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            const pipelines = advancePipelines(body, config.pipelines, config.orchestration.profiles);
            const nextConfig = { ...config, pipelines };
            await saveConfig(nextConfig, secrets);
            config = nextConfig;
            return pipelines;
          });
          return sendJson(res, 200, snapshot);
        }
      }

      if (path === "/api/pipeline-runs") {
        if (req.method === "GET") {
          return sendJson(res, 200, { runs: await pipelineRunStore.list() });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          if (typeof body.pipelineId !== "string" || !body.pipelineId.trim()) {
            throw new TypeError("pipeline_id_required");
          }
          if (typeof body.goal !== "string" || !body.goal.trim()) {
            throw new TypeError("pipeline_goal_required");
          }
          const sessionId = typeof body.sessionId === "string" && body.sessionId.trim()
            ? body.sessionId.trim()
            : "";
          if (sessionId && !store.getSession(sessionId)) {
            const error = new Error("session_not_found");
            error.code = "session_not_found";
            throw error;
          }
          const run = await mutateConfig(async () => {
            const configSnapshot = structuredClone(config);
            const secretsSnapshot = structuredClone(secrets);
            const definition = configSnapshot.pipelines.definitions.find(
              (candidate) => candidate.id === body.pipelineId.trim() && candidate.enabled,
            );
            if (!definition) {
              const error = new Error("pipeline_definition_not_found");
              error.code = "pipeline_definition_not_found";
              throw error;
            }
            if (!configSnapshot.workspace) throw new TypeError("pipeline_workspace_required");
            const [runtimeIdentity, workspaceBaseline] = await Promise.all([
              buildPipelineRuntimeIdentity(definition, configSnapshot, secretsSnapshot),
              observeWorkspace(configSnapshot.workspace),
            ]);
            return pipelineRunStore.create({
              pipelineId: definition.id,
              definitionRevision: String(definition.revision),
              ...runtimeIdentity,
              workspaceBaselineDigest: workspaceBaseline.digest,
              workspaceBaselineObservedAt: workspaceBaseline.observedAt,
              goal: body.goal.trim(),
              workspace: configSnapshot.workspace,
              attachedSessionIds: sessionId ? [sessionId] : [],
              stages: definition.stages.map((stage) => ({
                id: stage.id,
                name: stage.name,
                kind: stage.kind,
                teamProfileId: stage.teamProfileId,
                dependsOn: stage.dependsOn,
                writeCapable: stage.kind === "action",
                metadata: {
                  allowedHelpFrom: stage.allowedHelpFrom,
                  retry: stage.retry,
                  ...(stage.action ? { action: stage.action } : {}),
                },
              })),
              budget: {
                limits: definition.limits,
                reserved: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  calls: 0,
                  costUsd: 0,
                  wallTimeMs: 0,
                  repairCycles: 0,
                  assistanceRequests: 0,
                },
                consumed: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  calls: 0,
                  costUsd: 0,
                  wallTimeMs: 0,
                  repairCycles: 0,
                  assistanceRequests: 0,
                },
                unmeteredCalls: 0,
              },
            });
          });
          return sendJson(res, 201, { run });
        }
      }

      const pipelineRunMatch = path.match(/^\/api\/pipeline-runs\/([^/]+)(\/(?:start|pause|resume|cancel|approval|attach-session|artifact|journal))?$/);
      if (pipelineRunMatch) {
        let runId = "";
        try {
          runId = decodeURIComponent(pipelineRunMatch[1]).trim();
        } catch {
          throw new TypeError("pipeline_run_id_invalid");
        }
        if (!runId || runId.length > 300 || runId.includes("\0")) {
          throw new TypeError("pipeline_run_id_invalid");
        }
        const action = pipelineRunMatch[2] ?? "";
        if (!action && req.method === "GET") {
          const run = await pipelineRunStore.load(runId);
          if (!run) {
            const error = new Error("pipeline_run_not_found");
            error.code = "pipeline_run_not_found";
            throw error;
          }
          return sendJson(res, 200, { run });
        }
        if (action === "/journal" && req.method === "GET") {
          const current = await pipelineRunStore.load(runId);
          if (!current) {
            const error = new Error("pipeline_run_not_found");
            error.code = "pipeline_run_not_found";
            throw error;
          }
          const afterRaw = url.searchParams.get("afterSequence");
          const limitRaw = url.searchParams.get("limit");
          if (
            (afterRaw !== null && !/^\d+$/.test(afterRaw))
            || (limitRaw !== null && !/^\d+$/.test(limitRaw))
          ) throw new TypeError("pipeline_journal_page_invalid");
          const afterSequence = afterRaw === null ? 0 : Number(afterRaw);
          const limit = limitRaw === null ? 100 : Number(limitRaw);
          const events = await pipelineRunStore.readJournal(runId, { afterSequence, limit });
          const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence;
          return sendJson(res, 200, {
            runId,
            events,
            nextAfterSequence,
            hasMore: nextAfterSequence < current.sequence,
          });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          if (action === "/start") {
            const run = await mutateConfig(async () => {
              const current = await pipelineRunStore.load(runId);
              if (!current) {
                const error = new Error("pipeline_run_not_found");
                error.code = "pipeline_run_not_found";
                throw error;
              }
              const configSnapshot = structuredClone(config);
              const secretsSnapshot = structuredClone(secrets);
              await Promise.all([
                assertPipelineRuntimeCurrent(current, configSnapshot, secretsSnapshot),
                assertWorkspaceCheckpointCurrent(current),
              ]);
              return pipelineRunStore.start(runId);
            });
            void schedulePipelineAdvance(run.runId);
            return sendJson(res, 200, { run });
          }
          if (action === "/pause") {
            await interruptActivePipelineStage(runId, "pipeline_paused");
            return sendJson(res, 200, { run: await pipelineRunStore.pause(runId, { reason: body.reason }) });
          }
          if (action === "/artifact") {
            const artifact = body?.artifact ?? body;
            const run = await pipelineRunStore.recordArtifact(runId, artifact);
            return sendJson(res, 201, { run });
          }
          if (action === "/resume") {
            const run = await mutateConfig(async () => {
            const current = await pipelineRunStore.load(runId);
            if (!current) {
              const error = new Error("pipeline_run_not_found");
              error.code = "pipeline_run_not_found";
              throw error;
            }
            const configSnapshot = structuredClone(config);
            const secretsSnapshot = structuredClone(secrets);
            await assertPipelineRuntimeCurrent(current, configSnapshot, secretsSnapshot);
            const suppliedResolutionMarker = body.resolutionMarker !== undefined
              ? requireWriteResolutionMarker(body.resolutionMarker)
              : undefined;
            let suppliedResolutionMarkers;
            if (body.resolutionMarkers !== undefined) {
              if (!body.resolutionMarkers || typeof body.resolutionMarkers !== "object" || Array.isArray(body.resolutionMarkers)) {
                throw new TypeError("pipeline_write_resolution_invalid");
              }
              suppliedResolutionMarkers = Object.fromEntries(
                Object.entries(body.resolutionMarkers).map(([stageId, marker]) => [
                  stageId,
                  requireWriteResolutionMarker(marker),
                ]),
              );
            }
            const uncertainStages = current.stages.filter(
              (stage) => stage.status === "uncertain" || stage.uncertain === true,
            );
            if (!uncertainStages.length) await assertWorkspaceCheckpointCurrent(current);
            if (!uncertainStages.length && (suppliedResolutionMarker || suppliedResolutionMarkers)) {
              if (current.status !== "running") throw new TypeError("pipeline_write_resolution_invalid");
              const resolvedStages = current.stages.filter((stage) => stage.resolution?.marker);
              const requestedByStage = suppliedResolutionMarkers
                ?? (suppliedResolutionMarker && resolvedStages.length === 1
                  ? { [resolvedStages[0].id]: suppliedResolutionMarker }
                  : null);
              if (!requestedByStage || Object.keys(requestedByStage).length === 0) {
                throw new TypeError("pipeline_write_resolution_invalid");
              }
              for (const [stageId, supplied] of Object.entries(requestedByStage)) {
                const stage = resolvedStages.find((candidate) => candidate.id === stageId);
                const persistedMarker = stage?.resolution?.marker;
                if (!stage || !resolutionRequestMatchesPersisted(supplied, persistedMarker)) {
                  throw new TypeError("pipeline_write_resolution_invalid");
                }
                await verifyWriteResolutionMarker(supplied, current, stage);
                resolutionReceiptRegistry.add(persistedMarker);
                await workspaceLeaseStore.resolveQuarantine({
                  workspace: current.workspace,
                  runId: current.runId,
                  resolutionMarker: persistedMarker,
                });
              }
              return current;
            }
            const uncertainIds = new Set(uncertainStages.map((stage) => stage.id));
            if (suppliedResolutionMarkers && Object.keys(suppliedResolutionMarkers).some((stageId) => !uncertainIds.has(stageId))) {
              throw new TypeError("pipeline_write_resolution_invalid");
            }
            const verifiedByStage = {};
            for (const stage of uncertainStages) {
              const marker = suppliedResolutionMarkers?.[stage.id]
                ?? (uncertainStages.length === 1 ? suppliedResolutionMarker : undefined);
              if (marker) {
                const verified = await verifyWriteResolutionMarker(marker, current, stage);
                resolutionReceiptRegistry.add(verified);
                verifiedByStage[stage.id] = verified;
              }
            }
            const resumed = await pipelineRunStore.resume(runId, {
              ...(Object.keys(verifiedByStage).length
                ? { resolutionMarkers: verifiedByStage }
                : {}),
            });
            for (const marker of Object.values(verifiedByStage)) {
              await workspaceLeaseStore.resolveQuarantine({
                workspace: resumed.workspace,
                runId: resumed.runId,
                resolutionMarker: marker,
              });
            }
            return resumed;
            });
            void schedulePipelineAdvance(run.runId);
            return sendJson(res, 200, { run });
          }
          if (action === "/cancel") {
            await interruptActivePipelineStage(runId, "pipeline_cancelled");
            return sendJson(res, 200, { run: await pipelineRunStore.cancel(runId, { reason: body.reason }) });
          }
          if (action === "/approval") {
            const stageId = typeof body.stageId === "string" ? body.stageId.trim() : "";
            const current = await pipelineRunStore.load(runId);
            if (!current) {
              const error = new Error("pipeline_run_not_found");
              error.code = "pipeline_run_not_found";
              throw error;
            }
            const stage = current.stages.find((candidate) => candidate.id === stageId);
            if (!stage || stage.kind !== "approval") throw new TypeError("pipeline_approval_stage_invalid");
            let run = await pipelineRunStore.recordApproval(runId, {
                id: body.id,
                stageId,
                kind: body.kind,
                status: body.status,
                actor: "local-operator",
                reason: body.reason,
                evidence: body.evidence,
                metadata: {
                  ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
                  ...(typeof body.actor === "string" && body.actor.trim() ? { requestedActorLabel: body.actor.trim() } : {}),
                },
            });
            const approvalStatus = typeof body.status === "string" ? body.status : "requested";
            if (approvalStatus === "approved") {
              run = await pipelineRunStore.transition(runId, "running", {
                stageId,
                reason: "approval_approved",
              });
              void schedulePipelineAdvance(run.runId);
            } else if (["rejected", "cancelled", "expired"].includes(approvalStatus)) {
              run = await pipelineRunStore.transition(runId, "failed", {
                stageId,
                reason: `approval_${approvalStatus}`,
              });
            }
            return sendJson(res, 200, { run });
          }
          if (action === "/attach-session") {
            const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
            if (!sessionId || !store.getSession(sessionId)) {
              const error = new Error("session_not_found");
              error.code = "session_not_found";
              throw error;
            }
            return sendJson(res, 200, { run: await pipelineRunStore.attachSession(runId, sessionId) });
          }
        }
      }

      if (req.method === "GET" && path === "/api/provider-templates") {
        return sendJson(res, 200, publicProviderTemplates());
      }

      if (path === "/api/connectors/kiro") {
        if (req.method === "GET") return sendJson(res, 200, await kiroApi.status());
      }

      if (path === "/api/connectors/kiro/models") {
        if (req.method === "GET") return sendJson(res, 200, await kiroApi.models());
      }

      if (path === "/api/connectors/kiro/login") {
        if (req.method === "POST") return sendJson(res, 202, await kiroApi.startLogin(await readBody(req)));
      }

      if (path === "/api/connectors/kiro/logout") {
        if (req.method === "POST") return sendJson(res, 200, await kiroApi.logout());
      }

      const kiroLoginMatch = path.match(/^\/api\/connectors\/kiro\/login\/([^/]+)$/);
      if (kiroLoginMatch) {
        const loginId = decodeURIComponent(kiroLoginMatch[1]);
        if (req.method === "GET") return sendJson(res, 200, kiroApi.loginStatus(loginId));
        if (req.method === "DELETE") return sendJson(res, 200, kiroApi.cancelLogin(loginId));
      }

      if (req.method === "POST" && path === "/api/providers/discover") {
        const body = await readBody(req);
        const profile = body.profile && typeof body.profile === "object"
          ? body.profile
          : body.provider && typeof body.provider === "object"
            ? body.provider
            : body;
        const suppliedCredentials = normalizeProviderSecret(
          body.credentials && typeof body.credentials === "object"
            ? body.credentials
            : typeof body.apiKey === "string"
              ? { apiKey: body.apiKey }
              : {},
        );
        if (profile.protocol !== "openai-chat" && profile.protocol !== "openai-responses") {
          throw new ProviderDiscoveryError("provider_discovery_unsupported");
        }
        const requiresApiKey = profile.requiresApiKey !== false;
        const credentials = requiresApiKey ? suppliedCredentials : {};
        if (requiresApiKey && !credentials.apiKey) {
          throw new ProviderConfigError("provider_credentials_required");
        }
        const models = await providerDiscovery({
          protocol: profile.protocol,
          baseURL: profile.baseURL,
          headers: profile.headers,
          credentials,
          allowBenchmarkNetwork: profile.allowBenchmarkNetwork === true,
        });
        return sendJson(res, 200, { models, count: models.length });
      }

      if (path === "/api/providers") {
        if (req.method === "GET") {
          const snapshot = publicConfig();
          return sendJson(res, 200, {
            providers: snapshot.providers,
            activeProviderId: snapshot.activeProviderId,
            activeModelId: snapshot.activeModelId,
            modelAssignments: snapshot.modelAssignments,
          });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            const input = body.provider && typeof body.provider === "object" ? body.provider : body;
            const provider = validateProviderInput(input, { creating: true });
            if (config.providers.some((candidate) => candidate.id === provider.id)) {
              throw new ProviderConfigError("provider_id_conflict");
            }
            const suppliedCredentials = body.credentials && typeof body.credentials === "object"
              ? body.credentials
              : typeof body.apiKey === "string"
                ? { apiKey: body.apiKey }
                : null;
            let credentials = null;
            if (suppliedCredentials) {
              credentials = normalizeProviderSecret(suppliedCredentials);
              if (!Object.keys(credentials).length) throw new ProviderConfigError("provider_credentials_required");
              if (!hasStoredProviderCredentials(provider, credentials)) {
                throw new ProviderConfigError("provider_credentials_incomplete");
              }
            }
            const added = upsertProvider(config, provider, provider.id);
            let nextConfig = added.config;
            const nextSecrets = normalizeProviderSecrets(secrets);
            if (credentials) nextSecrets.providers[added.provider.id] = credentials;
            if (body.useAsDefault === true || body.activate === true) {
              nextConfig = selectExistingProviderModel(nextConfig, added.provider.id, body.modelId ?? input.model ?? added.provider.models[0]?.id);
              requireReadyProviderModel(
                nextConfig,
                nextSecrets,
                nextConfig.activeProviderId,
                nextConfig.activeModelId,
              );
            }
            nextConfig = reconcileReadyModelAssignments(nextConfig, nextSecrets);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            return publicGatewayConfig(config, secrets);
          });
          return sendJson(res, 201, snapshot);
        }
      }

      const providerPoolMatch = path.match(/^\/api\/providers\/([^/]+)\/pool$/);
      if (providerPoolMatch) {
        const providerId = decodeURIComponent(providerPoolMatch[1]);
        if (req.method === "GET") return sendJson(res, 200, publicProviderAccountPool(providerId));
        if (req.method === "PATCH") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            const existing = config.providers.find((provider) => provider.id === providerId);
            if (!existing) throw new ProviderConfigError("provider_not_found");
            const accountPool = validateProviderPoolInput(body.pool ?? body, existing.accountPool);
            let nextConfig = normalizeGatewayConfig({
              ...config,
              providers: config.providers.map((provider) => provider.id === providerId
                ? { ...provider, accountPool }
                : provider),
            });
            nextConfig = reconcileReadyRuntimeConfig(nextConfig, secrets);
            await saveConfig(nextConfig, secrets);
            config = nextConfig;
            invalidateProviderRuntime(providerId);
            return publicProviderAccountPool(providerId);
          });
          return sendJson(res, 200, snapshot);
        }
      }

      const providerAccountsMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts$/);
      if (providerAccountsMatch) {
        const providerId = decodeURIComponent(providerAccountsMatch[1]);
        if (req.method === "GET") return sendJson(res, 200, publicProviderAccountPool(providerId));
        if (req.method === "POST") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            const existing = config.providers.find((provider) => provider.id === providerId);
            if (!existing) throw new ProviderConfigError("provider_not_found");
            const pool = normalizeProviderAccountPool(existing.accountPool, existing.models);
            if (pool.members.length >= 64) throw new ProviderConfigError("provider_account_limit_reached");
            const input = body.account && typeof body.account === "object" ? body.account : body;
            const requestedId = typeof input.id === "string" && input.id.trim()
              ? input.id.trim().toLowerCase()
              : createProviderAccountId(input.name, pool.members);
            if (pool.members.some((member) => member.id === requestedId)) {
              throw new ProviderConfigError("provider_account_id_conflict");
            }
            const account = validateProviderAccountInput(
              { ...input, id: requestedId },
              { accountId: requestedId, providerModels: existing.models },
            );
            const supplied = body.credentials && typeof body.credentials === "object"
              ? body.credentials
              : typeof body.apiKey === "string"
                ? { apiKey: body.apiKey }
                : {};
            const credentials = normalizeProviderSecret(supplied);
            if (existing.requiresApiKey && !hasStoredProviderCredentials(existing, credentials)) {
              throw new ProviderConfigError("provider_credentials_incomplete");
            }
            const accountPool = normalizeProviderAccountPool(
              { ...pool, members: [...pool.members, account] },
              existing.models,
            );
            let nextConfig = normalizeGatewayConfig({
              ...config,
              providers: config.providers.map((provider) => provider.id === providerId
                ? { ...provider, accountPool }
                : provider),
            });
            const nextSecrets = Object.keys(credentials).length
              ? setProviderAccountCredentials(secrets, providerId, account.id, credentials)
              : normalizeProviderSecrets(secrets);
            nextConfig = reconcileReadyRuntimeConfig(nextConfig, nextSecrets);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            invalidateProviderRuntime(providerId);
            return publicProviderAccountPool(providerId);
          });
          return sendJson(res, 201, snapshot);
        }
      }

      const providerAccountMatch = path.match(/^\/api\/providers\/([^/]+)\/accounts\/([^/]+)(\/discover)?$/);
      if (providerAccountMatch) {
        const providerId = decodeURIComponent(providerAccountMatch[1]);
        const accountId = decodeURIComponent(providerAccountMatch[2]);
        const action = providerAccountMatch[3] ?? "";
        const existing = config.providers.find((provider) => provider.id === providerId);
        if (!existing) throw new ProviderConfigError("provider_not_found");
        const currentPool = normalizeProviderAccountPool(existing.accountPool, existing.models);
        const currentAccount = currentPool.members.find((account) => account.id === accountId);
        if (!currentAccount) throw new ProviderConfigError("provider_account_not_found");
        if (action === "/discover" && req.method === "POST") {
          if (existing.protocol !== "openai-chat" && existing.protocol !== "openai-responses") {
            throw new ProviderDiscoveryError("provider_discovery_unsupported");
          }
          const credentials = existing.requiresApiKey
            ? getProviderAccountCredentials(secrets, providerId, accountId)
            : {};
          if (existing.requiresApiKey && !hasStoredProviderCredentials(existing, credentials)) {
            throw new ProviderConfigError("provider_credentials_required");
          }
          const models = await providerDiscovery({
            protocol: existing.protocol,
            baseURL: existing.baseURL,
            headers: existing.headers,
            credentials,
          });
          return sendJson(res, 200, { models, count: models.length });
        }
        if (!action && req.method === "PATCH") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            const latest = config.providers.find((provider) => provider.id === providerId);
            if (!latest) throw new ProviderConfigError("provider_not_found");
            const latestPool = normalizeProviderAccountPool(latest.accountPool, latest.models);
            const previous = latestPool.members.find((account) => account.id === accountId);
            if (!previous) throw new ProviderConfigError("provider_account_not_found");
            const input = body.account && typeof body.account === "object" ? body.account : body;
            let account;
            if (accountId === "primary") {
              account = validateProviderAccountInput(
                { ...previous, ...input, id: "primary" },
                { accountId: "primary", providerModels: latest.models, allowPrimary: true },
              );
            } else {
              account = validateProviderAccountInput(
                { ...previous, ...input, id: accountId },
                { accountId, providerModels: latest.models },
              );
            }
            const accountPool = normalizeProviderAccountPool({
              ...latestPool,
              members: latestPool.members.map((candidate) => candidate.id === accountId ? account : candidate),
            }, latest.models);
            let nextConfig = normalizeGatewayConfig({
              ...config,
              providers: config.providers.map((provider) => provider.id === providerId
                ? { ...provider, accountPool }
                : provider),
            });
            let nextSecrets = normalizeProviderSecrets(secrets);
            if (body.credentials && typeof body.credentials === "object") {
              const credentials = normalizeProviderSecret(body.credentials);
              if (!hasStoredProviderCredentials(latest, credentials)) {
                throw new ProviderConfigError("provider_credentials_incomplete");
              }
              nextSecrets = setProviderAccountCredentials(nextSecrets, providerId, accountId, credentials);
            }
            nextConfig = reconcileReadyRuntimeConfig(nextConfig, nextSecrets);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            invalidateProviderRuntime(providerId);
            return publicProviderAccountPool(providerId);
          });
          return sendJson(res, 200, snapshot);
        }
        if (!action && req.method === "DELETE") {
          if (accountId === "primary") throw new ProviderConfigError("provider_primary_account_required");
          const snapshot = await mutateConfig(async () => {
            const latest = config.providers.find((provider) => provider.id === providerId);
            if (!latest) throw new ProviderConfigError("provider_not_found");
            const latestPool = normalizeProviderAccountPool(latest.accountPool, latest.models);
            if (!latestPool.members.some((account) => account.id === accountId)) {
              throw new ProviderConfigError("provider_account_not_found");
            }
            const accountPool = normalizeProviderAccountPool({
              ...latestPool,
              members: latestPool.members.filter((account) => account.id !== accountId),
            }, latest.models);
            let nextConfig = normalizeGatewayConfig({
              ...config,
              providers: config.providers.map((provider) => provider.id === providerId
                ? { ...provider, accountPool }
                : provider),
            });
            const nextSecrets = deleteProviderAccountCredentials(secrets, providerId, accountId);
            nextConfig = reconcileReadyRuntimeConfig(nextConfig, nextSecrets);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            for (const session of store.sessions) {
              if (session.providerId === providerId && session.providerAccountId === accountId) {
                store.upsertSession({ id: session.id, providerAccountId: undefined });
              }
            }
            invalidateProviderRuntime(providerId);
            return publicProviderAccountPool(providerId);
          });
          return sendJson(res, 200, snapshot);
        }
      }

      const providerMatch = path.match(/^\/api\/providers\/([^/]+)(\/(?:secret|discover))?$/);
      if (providerMatch) {
        const providerId = decodeURIComponent(providerMatch[1]);
        const action = providerMatch[2] ?? "";
        if (action === "/discover" && req.method === "POST") {
          const body = await readBody(req);
          const existing = config.providers.find((provider) => provider.id === providerId);
          if (!existing) return sendJson(res, 404, { code: "provider_not_found", error: "provider_not_found" });
          if (existing.protocol !== "openai-chat" && existing.protocol !== "openai-responses") {
            throw new ProviderDiscoveryError("provider_discovery_unsupported");
          }
          const credentials = existing.requiresApiKey ? secrets.providers[providerId] ?? {} : {};
          if (existing.requiresApiKey && !hasStoredProviderCredentials(existing, credentials)) {
            throw new ProviderConfigError("provider_credentials_required");
          }
          const models = await providerDiscovery({
            protocol: existing.protocol,
            baseURL: existing.baseURL,
            headers: existing.headers,
            credentials,
            allowBenchmarkNetwork: Boolean(body && typeof body === "object" && !Array.isArray(body) && body.allowBenchmarkNetwork === true),
          });
          return sendJson(res, 200, { models, count: models.length });
        }
        if (action === "/secret") {
          if (req.method === "PUT") {
            const body = await readBody(req);
            const snapshot = await mutateConfig(async () => {
              const existing = config.providers.find((provider) => provider.id === providerId);
              if (!existing) throw new ProviderConfigError("provider_not_found");
              const input = body.credentials && typeof body.credentials === "object" ? body.credentials : body;
              const credentials = normalizeProviderSecret(input);
              if (!Object.keys(credentials).length) throw new ProviderConfigError("provider_credentials_required");
              if (!hasStoredProviderCredentials(existing, credentials)) {
                throw new ProviderConfigError("provider_credentials_incomplete");
              }
              const nextSecrets = normalizeProviderSecrets(secrets);
              nextSecrets.providers[providerId] = credentials;
              await saveConfig(config, nextSecrets);
              secrets = nextSecrets;
              invalidateProviderRuntime(providerId);
              return publicGatewayConfig(config, secrets);
            });
            return sendJson(res, 200, snapshot);
          }
          if (req.method === "DELETE") {
            const snapshot = await mutateConfig(async () => {
              const existing = config.providers.find((provider) => provider.id === providerId);
              if (!existing) throw new ProviderConfigError("provider_not_found");
              const nextSecrets = normalizeProviderSecrets(secrets);
              delete nextSecrets.providers[providerId];
              let nextConfig = config;
              if (config.activeProviderId === providerId) {
                nextConfig = reconcileReadyDefault(nextConfig, nextSecrets);
              }
              nextConfig = reconcileReadyModelAssignments(nextConfig, nextSecrets);
              nextConfig = reconcileReadyOrchestration(nextConfig, nextSecrets);
              await saveConfig(nextConfig, nextSecrets);
              config = nextConfig;
              secrets = nextSecrets;
              invalidateProviderRuntime(providerId);
              return publicGatewayConfig(config, secrets);
            });
            return sendJson(res, 200, snapshot);
          }
        }
        if (!action && req.method === "PATCH") {
          const body = await readBody(req);
          const snapshot = await mutateConfig(async () => {
            const existing = config.providers.find((provider) => provider.id === providerId);
            if (!existing) throw new ProviderConfigError("provider_not_found");
            const patch = body.provider && typeof body.provider === "object" ? body.provider : body;
            const updatedProvider = validateProviderInput({ ...existing, ...patch }, { providerId });
            const suppliedCredentials = body.credentials && typeof body.credentials === "object"
              ? body.credentials
              : typeof body.apiKey === "string"
                ? { apiKey: body.apiKey }
                : null;
            let credentials = null;
            if (suppliedCredentials) {
              credentials = normalizeProviderSecret(suppliedCredentials);
              if (!Object.keys(credentials).length) throw new ProviderConfigError("provider_credentials_required");
              if (!hasStoredProviderCredentials(updatedProvider, credentials)) {
                throw new ProviderConfigError("provider_credentials_incomplete");
              }
            }
            const updated = upsertProvider(config, updatedProvider, providerId);
            let nextConfig = updated.config;
            const nextSecrets = normalizeProviderSecrets(secrets);
            if (providerCredentialScope(existing) !== providerCredentialScope(updated.provider)) {
              delete nextSecrets.providers[providerId];
              delete nextSecrets.accounts[providerId];
            }
            if (credentials) nextSecrets.providers[providerId] = credentials;
            if (body.useAsDefault === true || body.activate === true) {
              nextConfig = selectExistingProviderModel(nextConfig, providerId, body.modelId ?? updated.provider.models[0]?.id);
              requireReadyProviderModel(
                nextConfig,
                nextSecrets,
                nextConfig.activeProviderId,
                nextConfig.activeModelId,
              );
            }
            if (config.activeProviderId === providerId) {
              nextConfig = reconcileReadyDefault(nextConfig, nextSecrets);
            }
            nextConfig = reconcileReadyModelAssignments(nextConfig, nextSecrets);
            nextConfig = reconcileReadyOrchestration(nextConfig, nextSecrets);
            const prunedSecrets = pruneProviderAccountSecrets(nextSecrets, nextConfig.providers);
            await saveConfig(nextConfig, prunedSecrets);
            config = nextConfig;
            secrets = prunedSecrets;
            invalidateProviderRuntime(providerId);
            return publicGatewayConfig(config, secrets);
          });
          return sendJson(res, 200, snapshot);
        }
        if (!action && req.method === "DELETE") {
          const snapshot = await mutateConfig(async () => {
            if (!config.providers.some((provider) => provider.id === providerId)) {
              throw new ProviderConfigError("provider_not_found");
            }
            const nextSecrets = normalizeProviderSecrets(secrets);
            delete nextSecrets.providers[providerId];
            delete nextSecrets.accounts[providerId];
            let nextConfig = removeProvider(config, providerId);
            nextConfig = reconcileReadyDefault(nextConfig, nextSecrets);
            nextConfig = reconcileReadyModelAssignments(nextConfig, nextSecrets);
            nextConfig = reconcileReadyOrchestration(nextConfig, nextSecrets);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            invalidateProviderRuntime(providerId);
            return publicGatewayConfig(config, secrets);
          });
          return sendJson(res, 200, snapshot);
        }
        if (!config.providers.some((provider) => provider.id === providerId)) {
          return sendJson(res, 404, { code: "provider_not_found", error: "provider_not_found" });
        }
      }

      if (req.method === "POST" && path === "/api/choose-folder") {
        const folder = chooseFolder ? await chooseFolder() : "";
        let snapshot = publicConfig();
        if (folder) {
          snapshot = await mutateConfig(async () => {
            const nextConfig = { ...config, workspace: folder };
            await skillsStore.setWorkspace(folder);
            await saveConfig(nextConfig, secrets);
            config = nextConfig;
            return publicGatewayConfig(config, secrets);
          });
        }
        return sendJson(res, 200, { folder: folder || "", ...snapshot });
      }

      if (path === "/api/skills") {
        if (req.method === "GET") {
          return sendJson(res, 200, { skills: await skillsStore.list(), roots: await skillsStore.roots() });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          return sendJson(res, 201, { skill: await skillsStore.create(body) });
        }
      }

      if (path === "/api/skills/roots") {
        if (req.method === "POST") {
          const folder = chooseFolder ? await chooseFolder() : "";
          if (folder) await skillsStore.addRoot(folder);
          return sendJson(res, 200, { folder, roots: await skillsStore.roots() });
        }
      }

      const skillRootMatch = path.match(/^\/api\/skills\/roots\/([^/]+)(\/open)?$/);
      if (skillRootMatch) {
        const rootId = decodeURIComponent(skillRootMatch[1]);
        if (skillRootMatch[2] === "/open" && req.method === "POST") {
          const root = (await skillsStore.roots()).find(candidate => candidate.id === rootId);
          if (!root) return sendJson(res, 404, { code: "root_not_found", error: "root_not_found" });
          if (!root.available) return sendJson(res, 409, { code: "root_unavailable", error: "root_unavailable" });
          if (!openPath) return sendJson(res, 501, { code: "open_path_unavailable", error: "open_path_unavailable" });
          await openPath(root.path);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === "DELETE") {
          await skillsStore.removeRoot(rootId);
          return sendJson(res, 200, { roots: await skillsStore.roots() });
        }
      }

      const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch) {
        const skillId = decodeURIComponent(skillMatch[1]);
        if (req.method === "GET") return sendJson(res, 200, { skill: await skillsStore.get(skillId) });
        if (req.method === "PATCH") {
          const body = await readBody(req);
          if (typeof body.enabled !== "boolean") throw new TypeError("skill-enabled-invalid");
          return sendJson(res, 200, { skill: await skillsStore.setEnabled(skillId, body.enabled) });
        }
        if (req.method === "DELETE") return sendJson(res, 200, await skillsStore.delete(skillId));
      }

      if (path === "/api/cron/jobs") {
        if (req.method === "GET") return sendJson(res, 200, { jobs: cronStore.list().map(publicCronJob) });
        if (req.method === "POST") {
          const body = await readBody(req);
          const job = await cronStore.create({
            name: body.name,
            prompt: body.prompt,
            expression: body.schedule ?? body.expression,
            enabled: body.enabled,
          });
          return sendJson(res, 201, { job: publicCronJob(job) });
        }
      }

      const cronMatch = path.match(/^\/api\/cron\/jobs\/([^/]+)(\/(?:pause|resume|trigger|runs))?$/);
      if (cronMatch) {
        const jobId = decodeURIComponent(cronMatch[1]);
        const action = cronMatch[2];
        if (!action && req.method === "GET") {
          const job = cronStore.get(jobId);
          if (!job) return sendJson(res, 404, { code: "cron-job-not-found", error: "cron-job-not-found" });
          return sendJson(res, 200, { job: publicCronJob(job) });
        }
        if (!action && req.method === "PATCH") {
          const body = await readBody(req);
          const patch = {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
            ...(body.schedule !== undefined || body.expression !== undefined ? { expression: body.schedule ?? body.expression } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          };
          return sendJson(res, 200, { job: publicCronJob(await cronStore.update(jobId, patch)) });
        }
        if (!action && req.method === "DELETE") {
          const ok = await cronStore.remove(jobId);
          return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { code: "cron-job-not-found", error: "cron-job-not-found" });
        }
        if (action === "/pause" && req.method === "POST") {
          return sendJson(res, 200, { job: publicCronJob(await cronStore.pause(jobId)) });
        }
        if (action === "/resume" && req.method === "POST") {
          return sendJson(res, 200, { job: publicCronJob(await cronStore.resume(jobId)) });
        }
        if (action === "/trigger" && req.method === "POST") {
          const run = await cronScheduler.trigger(jobId);
          return sendJson(res, 200, { job: publicCronJob(cronStore.get(jobId)), run: publicCronRun(run) });
        }
        if (action === "/runs" && req.method === "GET") {
          return sendJson(res, 200, { runs: cronStore.history(jobId).map(publicCronRun) });
        }
      }

      if (path === "/api/sessions") {
        if (req.method === "GET") {
          const sessions = store.sessions.map(s => ({ ...s, status: runtimeStatus.get(s.id) || "idle" }));
          return sendJson(res, 200, { sessions });
        }
        if (req.method === "POST") {
          const session = createSession();
          return sendJson(res, 200, { id: session.id, session });
        }
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        if (sessionMatch[2] === "/messages" && req.method === "GET") {
          return sendJson(res, 200, { session_id: id, messages: store.getMessages(id) });
        }
        if (req.method === "DELETE") { store.removeSession(id); return sendJson(res, 200, { ok: true }); }
        if (req.method === "PATCH") {
          const body = await readBody(req);
          const current = store.getSession(id);
          if (!current) return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
          const patch = { id, updatedAt: new Date().toISOString() };
           if (Object.hasOwn(body, "title")) {
             patch.title = redactSensitiveText(String(body.title ?? ""), runtimeSensitiveValues()).slice(0, 120);
           }
          if (Object.hasOwn(body, "providerId") || Object.hasOwn(body, "modelId")) {
            if (
              (Object.hasOwn(body, "providerId") && typeof body.providerId !== "string") ||
              (Object.hasOwn(body, "modelId") && typeof body.modelId !== "string")
            ) throw new ProviderConfigError("provider_selection_invalid");
            const providerId = typeof body.providerId === "string" && body.providerId.trim()
              ? body.providerId.trim()
              : current.providerId || config.activeProviderId;
            const provider = config.providers.find((candidate) => candidate.id === providerId && candidate.enabled);
            const requestedModelId = typeof body.modelId === "string" && body.modelId.trim()
              ? body.modelId.trim()
              : providerId === current.providerId && current.modelId
                ? current.modelId
                : provider?.models[0]?.id;
            const target = requireReadyProviderModel(config, secrets, providerId, requestedModelId);
            patch.providerId = target.provider.id;
            patch.modelId = target.model.id;
            if (target.provider.id !== current.providerId) patch.providerAccountId = undefined;
          }
          const session = store.upsertSession(patch);
          return sendJson(res, 200, { ok: true, session });
        }
      }

      if (req.method === "GET" && path === "/api/events") {
        const sessionId = url.searchParams.get("session") || "";
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...(res.kyreiCors ?? {}),
        });
        res.write(`data: ${JSON.stringify({ type: "gateway.ready" })}\n\n`);
        if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
        subscribers.get(sessionId).add(res);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25_000);
        req.on("close", () => { clearInterval(ping); subscribers.get(sessionId)?.delete(res); });
        return;
      }

      if (req.method === "POST" && path === "/api/prompt") {
        const body = await readBody(req);
        const sessionId = String(body.session || "");
        const text = String(body.text || "").trim();
        if (!sessionId || !text) return sendJson(res, 400, { error: "session and text required" });
        if (controllers.has(sessionId)) return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
        sendJson(res, 200, { status: "streaming" });
        void runPrompt(sessionId, text, body.modelParams);
        return;
      }

      if (req.method === "POST" && path === "/api/cancel") {
        const body = await readBody(req);
        if (body.session) {
          const sid = String(body.session);
          controllers.get(sid)?.abort();
        }
        return sendJson(res, 200, { ok: true });
      }

      // ── Workspace file explorer ──────────────────────────────────────
      if (req.method === "GET" && path === "/api/files") {
        if (!config.workspace) return sendJson(res, 200, { root: "", path: "", entries: [] });
        const rel = url.searchParams.get("path") || "";
        let abs;
        try {
          const mod = await getEngine();
          abs = typeof mod.safePath === "function" ? mod.safePath(config.workspace, rel || ".") : resolve(config.workspace, rel);
          if (typeof mod.safePath !== "function" && relative(config.workspace, abs).startsWith("..")) {
            return sendJson(res, 400, { error: "path outside workspace" });
          }
        } catch {
          return sendJson(res, 400, { error: "path outside workspace" });
        }
        try {
          const dirents = await readdir(abs, { withFileTypes: true });
          const entries = dirents
            .filter(d => !d.name.startsWith(".") || d.name === ".env.example")
            .map(d => ({ name: d.name, path: relative(config.workspace, resolve(abs, d.name)).replaceAll("\\", "/"), dir: d.isDirectory() }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          return sendJson(res, 200, { root: config.workspace, path: relative(config.workspace, abs).replaceAll("\\", "/"), entries });
        } catch (e) {
          return sendJson(res, 404, { error: e.message });
        }
      }

      if (req.method === "GET" && path === "/api/file") {
        if (!config.workspace) return sendJson(res, 400, { error: "no workspace" });
        const rel = url.searchParams.get("path") || "";
        let abs;
        try {
          const mod = await getEngine();
          abs = typeof mod.safePath === "function" ? mod.safePath(config.workspace, rel || ".") : resolve(config.workspace, rel);
          if (typeof mod.safePath !== "function" && relative(config.workspace, abs).startsWith("..")) {
            return sendJson(res, 400, { error: "path outside workspace" });
          }
        } catch {
          return sendJson(res, 400, { error: "path outside workspace" });
        }
        try {
          const info = await stat(abs);
          if (info.size > 500_000) return sendJson(res, 200, { path: rel, content: "[файл слишком большой для предпросмотра]", truncated: true });
          const content = await readFile(abs, "utf8");
          return sendJson(res, 200, { path: rel, content });
        } catch (e) {
          return sendJson(res, 404, { error: e.message });
        }
      }

      // ── Model catalog (known engine models) ──────────────────────────
      if (req.method === "GET" && path === "/api/models") {
        let models = [];
        try {
          const mod = await getEngine();
          models = typeof mod.listModels === "function" ? mod.listModels() : [];
        } catch { /* engine bundle unavailable — degrade to manual entry */ }
        const knownById = new Map(models.map(entry => [entry.id, entry]));
        const configuredModels = config.providers
          .filter((provider) => providerIsReady(provider, secrets))
          .flatMap((provider) => provider.models.map((model) => {
          const candidate = knownById.get(model.id);
          const known = candidate && sameModelEndpoint(provider.baseURL, candidate.baseURL) ? candidate : undefined;
          return {
            id: model.id,
            name: model.name ?? model.id,
            provider: provider.id,
            providerName: provider.name,
            baseURL: provider.baseURL,
            limits: known?.limits ?? { contextWindow: 32_000, maxOutput: 4_096 },
            cost: known?.cost ?? { inputPerM: 0, outputPerM: 0 },
            caps: known?.caps ?? { tools: true, reasoning: false, streaming: true, vision: false },
          };
        }));
        return sendJson(res, 200, {
          models: configuredModels,
          current: config.activeModelId,
          provider: config.activeProviderId,
          activeProviderId: config.activeProviderId,
        });
      }

      // ── Path autocompletion for @-mentions (jail-safe) ───────────────
      if (req.method === "POST" && path === "/api/complete-path") {
        if (!config.workspace) return sendJson(res, 200, { entries: [] });
        const body = await readBody(req);
        const query = String(body.path || "");
        // Split into a directory part + a name prefix to filter on.
        const slash = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
        const dirRel = slash >= 0 ? query.slice(0, slash) : "";
        const prefix = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
        try {
          const mod = await getEngine();
          // Validate the directory stays inside the workspace via the engine jail.
          const absDir = typeof mod.safePath === "function"
            ? mod.safePath(config.workspace, dirRel || ".")
            : resolve(config.workspace, dirRel || ".");
          const dirents = await readdir(absDir, { withFileTypes: true });
          const entries = dirents
            .filter(d => d.name.toLowerCase().startsWith(prefix) && (!d.name.startsWith(".") || prefix.startsWith(".")))
            .slice(0, 50)
            .map(d => {
              const rel = (dirRel ? dirRel.replace(/\\/g, "/") + "/" : "") + d.name;
              return { name: d.name, path: rel, dir: d.isDirectory() };
            })
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          return sendJson(res, 200, { entries });
        } catch {
          return sendJson(res, 200, { entries: [] });
        }
      }

      sendJson(res, 404, { error: `Not found: ${req.method} ${path}` });
    } catch (error) {
      const status = requestErrorStatus(error);
      const publicCode = typeof error?.code === "string"
        ? error.code
        : status < 500 && typeof error?.message === "string"
          ? error.message
          : "internal_error";
      sendJson(res, status, { code: publicCode, error: publicCode });
    }
  });

  let closePromise = null;
  const closeGateway = () => {
    if (closePromise) return closePromise;
    // Stop accepting new work immediately, cancel active engine turns and
    // direct Pipeline departments, then flush their durable state.
    shutdownController.abort();
    server.close();
    for (const controller of controllers.values()) controller.abort();
    for (const controller of pipelineAdvanceControllers.values()) {
      if (!controller.signal.aborted) controller.abort(new Error("gateway_shutdown"));
    }
    closePromise = (async () => {
      const connectorClose = Promise.resolve(kiroApi.close()).catch(() => undefined);
      await cronScheduler.stop();
      await configMutationTail;
      await persistence.drain();
      await teamRunStore.flush();
      await pipelineRunStore.flush();
      await workspaceLeaseStore.flush();
      await store.close();
      await connectorClose;
    })();
    return closePromise;
  };

  return new Promise((resolve, reject) => {
    const onError = error => {
      if (error.code === "EADDRINUSE" && server.listening === false) {
        server.removeListener("error", onError);
        server.once("error", fallbackError => { void cronScheduler.stop(); reject(fallbackError); });
        server.listen(0, "127.0.0.1", () => resolve({
          port: server.address().port,
          token: gatewayToken,
          close: closeGateway,
        }));
        return;
      }
      void cronScheduler.stop();
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferredPort, "127.0.0.1", () => resolve({
      port: server.address().port,
      token: gatewayToken,
      close: closeGateway,
    }));
  });
}
