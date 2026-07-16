/**
 * Orchestrator: the engine entry. Builds provider candidates + tools, runs the
 * AI SDK tool-calling loop via streamText (with no-tools + provider fallback
 * via openStream), bridges the normalized stream to our events, returns
 * { text, parts, status, attempts }.
 *
 * prepareStep: two-stage context compaction (tool CCR prune + optional summary).
 */

import { streamText, type ModelMessage, type ToolSet } from "ai";
import { join } from "node:path";
import type {
  RunKyreiChatOpts,
  RunKyreiChatResult,
  MessagePart,
  ProviderAttemptOutcome,
  ProviderAttemptTarget,
  RuntimeModelLimits,
  RuntimeProviderTarget,
} from "../types.js";
import { buildModel, buildProviderOptions, hasProviderCredentials } from "../provider/build.js";
import { resolveEngineConfig } from "../config/schema.js";
import { resolve as resolveModel } from "../provider/registry.js";
import { KeyPool } from "../provider/keys.js";
import {
  openStream,
  streamAttemptsFromError,
  type ProviderStreamAttemptOutcome,
  type StreamLike,
} from "../provider/open-stream.js";
import { buildTools, type ToolMeta } from "../tools/index.js";
import { buildWebTools } from "../tools/web.js";
import { buildGBrainTools } from "../tools/gbrain.js";
import { buildPlanningTools } from "../tools/planning.js";
import { buildOpenVikingTools } from "../tools/openviking.js";
import { buildMemorySearchTools } from "../tools/memory-search.js";
import { buildMemoryWriteTools } from "../tools/memory-write.js";
import { buildMcpTools } from "../tools/mcp.js";
import { buildSkillTools } from "../tools/skills.js";
import { createMcpManager, normalizeMcpConfig } from "../mcp/manager.js";
import { buildDelegateTool } from "../orchestration/delegate.js";
import { createReadOnlyChildRunner, selectReadOnlyChildTools } from "../orchestration/read-child.js";
import {
  buildTeamDelegateTool,
  createTeamRoleExecutors,
} from "../team/index.js";
import { isWorkspaceDir } from "../security/jail.js";
import { createCcrStore, makeRetrieveTool } from "../context/ccr.js";
import { assembleSystemContext } from "../memory/layers.js";
import { MemoryIndexSession } from "../memory/index-session.js";
import { snippetsFromModelMessages } from "../memory/session-project.js";
import { configureEmbedAdapterFromConfig } from "../memory/embed-adapter.js";
import { createStores, type Stores } from "../data/index.js";
import {
  createModelGoalJudge,
  maybeVerifyTurnGoal,
  prepareMessagesForModel,
} from "../reliability/runtime.js";
import { collectFileReviewFromParts, canEnterFileReview } from "../reliability/file-review.js";
import { extractHeuristicHandoff, writeHandoff } from "../memory/handoff.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolvePersonalityText } from "../personality-catalog.js";
import { buildStopWhen, type GuardStopReason } from "./stop-conditions.js";
import { makePrepareStep } from "./prepare-step.js";
import { emitNoKeyGuidance } from "./no-key-guidance.js";
import { bridgeStream } from "../stream-bridge/bridge.js";
import { toParts } from "./persist.js";
import { createAuditLog } from "../security/audit.js";
import { redact } from "../security/secrets.js";
import { approvedApprovalId, evaluateToolApproval } from "../security/tool-approval.js";

const MODEL_OVERRIDE_BOUNDS = Object.freeze({
  contextWindow: { min: 256, max: 100_000_000 },
  maxOutput: { min: 1, max: 10_000_000 },
});

function boundedModelOverride(
  value: unknown,
  kind: keyof typeof MODEL_OVERRIDE_BOUNDS,
): number | undefined {
  const bounds = MODEL_OVERRIDE_BOUNDS[kind];
  return Number.isSafeInteger(value)
    && (value as number) >= bounds.min
    && (value as number) <= bounds.max
    ? value as number
    : undefined;
}

function sanitizeRuntimeModelLimits(value: RuntimeModelLimits | undefined): RuntimeModelLimits | undefined {
  const contextWindow = boundedModelOverride(value?.contextWindow, "contextWindow");
  const maxOutput = boundedModelOverride(value?.maxOutput, "maxOutput");
  return contextWindow !== undefined || maxOutput !== undefined
    ? {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
      }
    : undefined;
}

function throwWithProviderAttempts(error: unknown, attempts: ProviderAttemptOutcome[]): never {
  let target: Error;
  if (error instanceof Error && Object.isExtensible(error)) {
    target = error;
  } else {
    target = new Error(error instanceof Error ? error.message : "provider_run_error", { cause: error });
    if (error instanceof Error) target.name = error.name;
  }
  Object.defineProperty(target, "providerAttempts", {
    configurable: true,
    enumerable: false,
    value: attempts.map((attempt) => ({ ...attempt })),
  });
  throw target;
}

function sensitiveRuntimeValues(...sources: unknown[]): string[] {
  const values = new Set<string>();
  const secretFields = new Set(["apiKey", "accessKeyId", "secretAccessKey", "sessionToken", "privateKey"]);
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (value.length > 0) values.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (secretFields.has(key)) visit(item, depth + 1);
      }
    }
  };
  sources.forEach((source) => visit(source, 0));
  return [...values];
}

function redactApprovalArgs(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(redact(JSON.stringify(value), sensitiveValues));
  } catch {
    return "[redacted]";
  }
}

export async function runKyreiChat(opts: RunKyreiChatOpts): Promise<RunKyreiChatResult> {
  const { config: cfg, warnings } = resolveEngineConfig(opts.config);
  if (warnings.length) console.warn("[kyrei v2] config:", warnings.join("; "));
  opts.emit({ type: "message.start" });

  const providerCredentials = {
    ...(opts.providerCredentials ?? {}),
    ...(!opts.providerCredentials?.apiKey && opts.apiKey ? { apiKey: opts.apiKey } : {}),
  };
  const sensitiveValues = sensitiveRuntimeValues(
    opts.apiKey,
    providerCredentials,
    opts.workerProvider?.apiKey,
    opts.workerProvider?.credentials,
    opts.fallbackProviders?.map((target) => [target.apiKey, target.credentials]),
    opts.team?.roles.map((role) => [role.target.apiKey, role.target.credentials]),
  );
  if (opts.requiresApiKey !== false && !hasProviderCredentials(opts.providerProtocol, providerCredentials)) {
    return emitNoKeyGuidance(opts.emit);
  }

  const workspaceReady = Boolean(opts.workspace) && (await isWorkspaceDir(opts.workspace!));
  const toolMeta = new Map<string, ToolMeta>();
  const approvedToolCalls = new Map<string, string>();
  const approvalMeta = new Map<string, { reason: string; args: unknown; name?: string }>();
  const consumeApprovedCall = async (approvalId: string, toolCallId: string): Promise<void> => {
    await opts.onApprovalConsumed?.(approvalId, toolCallId);
    opts.emit({
      type: "approval.consumed",
      payload: { approval_id: approvalId, tool_call_id: toolCallId },
    });
  };
  const ccr = workspaceReady ? createCcrStore(join(opts.workspace!, ".kyrei", "ccr")) : null;
  const audit = opts.auditLogPath ? createAuditLog(opts.auditLogPath) : undefined;

  // Configure process embedder (lexical default; optional HTTP neural endpoint).
  try {
    configureEmbedAdapterFromConfig(cfg.memory.index?.embed);
  } catch {
    /* keep lexical */
  }

  // Optional dual-write chat mirror (read FTS). JSON UI SoT stays in gateway.
  let sessionMirrorStores: Stores | null = null;
  if (
    opts.sessionMirrorDir
    && cfg.memory.sessionMirror?.enabled !== false
    && cfg.memory.sessionMirror?.readSearch !== false
  ) {
    try {
      sessionMirrorStores = createStores(opts.sessionMirrorDir);
    } catch (error) {
      console.warn("[kyrei session-mirror] read path unavailable:", error);
      sessionMirrorStores = null;
    }
  }

  // Rebuildable FTS+vector projection (process pool; never replaces Tier A SoT).
  let memoryIndex: MemoryIndexSession | null = null;
  if (workspaceReady) {
    try {
      memoryIndex = await MemoryIndexSession.acquire({
        workspace: opts.workspace!,
        config: {
          enabled: cfg.memory.index?.enabled,
          backend: cfg.memory.index?.backend,
          ...(cfg.memory.index?.connectionString
            ? { connectionString: cfg.memory.index.connectionString }
            : {}),
        },
        ltmEnabled: Boolean(cfg.memory.ltm?.enabled),
        planningEnabled: Boolean(cfg.planning?.enabled),
      });
      await memoryIndex.reindexNow();
    } catch (indexErr) {
      console.warn("[kyrei memory-index] unavailable:", indexErr);
      memoryIndex = null;
    }
  }
  const onMemoryMutated = (): void => {
    memoryIndex?.notifyMutated();
  };
  // Throttle LTM runtime snapshot refresh after file events (not every keystroke-level write).
  let lastLtmSnapshotAt = 0;
  const onLtmEvent = (): void => {
    if (!cfg.memory.ltm?.enabled || !opts.workspace) return;
    const now = Date.now();
    if (now - lastLtmSnapshotAt < 5_000) return;
    lastLtmSnapshotAt = now;
    const ltmDir = join(opts.workspace, "ltm");
    void import("../memory/ltm-bridge.js")
      .then(({ createLtmBridge }) => createLtmBridge(ltmDir).refreshRuntimeSnapshot())
      .then(() => onMemoryMutated())
      .catch(() => undefined);
  };
  const releaseMemoryIndex = async (): Promise<void> => {
    if (memoryIndex) {
      await memoryIndex.release();
      memoryIndex = null;
    }
    if (sessionMirrorStores) {
      try {
        await sessionMirrorStores.close();
      } catch {
        /* ignore */
      }
      sessionMirrorStores = null;
    }
  };

  // Clean-context reviewer (Requirements §11.3) reuses the primary provider's
  // credentials/endpoint — no separate account is provisioned for it. It is
  // an isolated *call* (fresh messages, no tools, no history), not a
  // separate identity, so it never needs its own credential surface.
  const reviewModel = cfg.review?.cleanContext
    ? buildModel({
        protocol: opts.providerProtocol,
        baseURL: opts.providerBase,
        apiKey: opts.apiKey,
        credentials: providerCredentials,
        model: opts.model,
        headers: opts.providerHeaders,
      })
    : undefined;
  const workspaceTools = workspaceReady
    ? buildTools(opts.workspace!, cfg, toolMeta, {
        abortSignal: opts.abortSignal,
        audit,
        sessionId: opts.sessionId,
        actorId: "main",
        commandRunner: opts.commandRunner,
        sensitiveValues,
        approvedToolCalls,
        onApprovalConsumed: consumeApprovedCall,
        onMemoryMutated,
        onLtmEvent,
        ...(cfg.memory.ltm?.enabled ? { ltmDir: join(opts.workspace!, "ltm") } : {}),
        ...(reviewModel ? { reviewModel } : {}),
      })
    : undefined;
  const retrieveTools: ToolSet = ccr ? { retrieve: makeRetrieveTool(ccr) } : {};
  const webTools = buildWebTools(cfg, {
    ...(audit ? { audit } : {}),
    sessionId: opts.sessionId,
    signal: opts.abortSignal,
    sensitiveValues,
  });
  const brainTools = buildGBrainTools(cfg.memory.gbrain, {
    signal: opts.abortSignal,
    maxModelOutputChars: cfg.maxToolOutput,
  });
  const planningTools =
    workspaceReady && cfg.planning?.enabled
      ? buildPlanningTools({
          workspace: opts.workspace!,
          maxModelOutputChars: cfg.maxToolOutput,
          onMemoryMutated,
        })
      : {};
  const openvikingTools = buildOpenVikingTools(
    {
      enabled: Boolean(cfg.memory.openviking?.enabled),
      ...(cfg.memory.openviking?.baseURL ? { baseURL: cfg.memory.openviking.baseURL } : {}),
    },
    {
      sessionId: opts.sessionId,
      maxModelOutputChars: cfg.maxToolOutput,
    },
  );
  const sessionSnippets = snippetsFromModelMessages(opts.messages ?? [], {
    sensitiveValues,
  });
  const memorySearchTools = workspaceReady
    ? buildMemorySearchTools({
        workspace: opts.workspace!,
        ...(cfg.memory.ltm?.enabled ? { ltmDir: join(opts.workspace!, "ltm"), ltmEnabled: true } : { ltmEnabled: false }),
        planningEnabled: Boolean(cfg.planning?.enabled),
        maxModelOutputChars: cfg.maxToolOutput,
        indexBackend: memoryIndex?.backendLabel ?? "off",
        ...(memoryIndex?.memoryStore ? { memoryStore: memoryIndex.memoryStore } : {}),
        ...(memoryIndex?.vectorStore ? { vectorStore: memoryIndex.vectorStore } : {}),
        ...(sessionMirrorStores ? { sessionStore: sessionMirrorStores.sessions } : {}),
        ...(sessionSnippets.length ? { sessionSnippets } : {}),
      })
    : {};
  const memoryWriteTools = workspaceReady
    ? buildMemoryWriteTools({
        workspace: opts.workspace!,
        maxModelOutputChars: cfg.maxToolOutput,
        onMemoryMutated,
        ...(opts.globalMemoryDir ? { globalDir: opts.globalMemoryDir } : {}),
      })
    : {};
  const mcpConfig = normalizeMcpConfig(cfg.mcp);
  const mcpManager =
    mcpConfig.enabled && mcpConfig.servers.length
      ? createMcpManager({ config: mcpConfig, sensitiveValues })
      : null;
  const mcpTools = mcpManager
    ? buildMcpTools(mcpConfig, {
        manager: mcpManager,
        sensitiveValues,
        maxModelOutputChars: cfg.maxToolOutput,
      })
    : {};
  const skillTools = buildSkillTools(opts.skills ?? [], {
    maxOutputChars: cfg.maxToolOutput,
    onUsed: opts.onSkillUsed,
    ...(opts.readSkillDocument ? { readDocument: opts.readSkillDocument } : {}),
  });
  // Delegates receive a separately constructed reader without the parent's
  // usage callback. Loading instructions must remain a read-only child action.
  const childSkillTools = buildSkillTools(opts.skills ?? [], {
    maxOutputChars: cfg.maxToolOutput,
    ...(opts.readSkillDocument ? { readDocument: opts.readSkillDocument } : {}),
  });
  const baseToolSet: ToolSet = {
    ...(workspaceTools ?? {}),
    ...retrieveTools,
    ...webTools,
    ...brainTools,
    ...planningTools,
    ...openvikingTools,
    ...memorySearchTools,
    ...memoryWriteTools,
    ...mcpTools,
    ...skillTools,
  };
  const tools = Object.keys(baseToolSet).length ? baseToolSet : undefined;
  // MCP is intentionally not available to read-only children (external process surface).
  const childTools = selectReadOnlyChildTools(
    workspaceTools,
    retrieveTools,
    webTools,
    brainTools,
    planningTools,
    openvikingTools,
    memorySearchTools,
    childSkillTools,
  );
  const delegationEnabled = cfg.delegation.enabled;
  const teamEnabled = Boolean(opts.team?.roles.length);
  const hasTools = Boolean(tools) || delegationEnabled || teamEnabled;

  let projectContext: string | undefined;
  if (workspaceReady) {
    try {
      const assembled = await assembleSystemContext({
        workspace: opts.workspace!,
        ...(cfg.memory?.ltm?.enabled ? { ltmDir: join(opts.workspace!, "ltm") } : {}),
        ...(cfg.planning?.enabled ? { includePlan: true } : {}),
        ...(opts.globalMemoryDir ? { globalDir: opts.globalMemoryDir } : {}),
      });
      projectContext = assembled.trim() ? assembled : undefined;
    } catch (error) {
      console.warn("[kyrei v2] project context disabled:", error);
    }
  }

  const teamExecutors = opts.team
    ? await createTeamRoleExecutors({
        spec: opts.team,
        config: cfg,
        workspace: opts.workspace,
        auditLogPath: opts.auditLogPath,
        sessionId: opts.sessionId,
        abortSignal: opts.abortSignal,
        skills: opts.skills,
        projectContext,
        sensitiveValues,
        emit: opts.emit,
        onSkillUsed: opts.onSkillUsed,
        ...(opts.readSkillDocument ? { readSkillDocument: opts.readSkillDocument } : {}),
        providerAttemptLifecycle: opts.providerAttemptLifecycle,
        ...(memoryIndex?.memoryStore ? { memoryStore: memoryIndex.memoryStore } : {}),
        ...(memoryIndex?.vectorStore ? { vectorStore: memoryIndex.vectorStore } : {}),
        indexBackend: memoryIndex?.backendLabel ?? "off",
        ...(opts.globalMemoryDir ? { globalMemoryDir: opts.globalMemoryDir } : {}),
      })
    : [];
  const teamTools = opts.team
    ? buildTeamDelegateTool({
        spec: { ...opts.team, roles: teamExecutors.map((executor) => executor.role) },
        executors: teamExecutors,
        emit: opts.emit,
        abortSignal: opts.abortSignal,
        maxResultChars: cfg.maxToolOutput,
      })
    : {};
  const instructions = buildSystemPrompt({
    workspace: opts.workspace,
    hasTools,
    personality: resolvePersonalityText({
      personality: cfg.personality,
      personalityPresetId: cfg.personalityPresetId,
    }),
    timezone: cfg.timezone,
    promptProfile: cfg.promptProfiles.find((profile) => profile.id === cfg.activePromptProfileId)?.systemPrompt,
    projectContext,
    hasBrainTools: Object.keys(brainTools).length > 0,
    hasBrainWriteTools: cfg.memory.gbrain.mode === "read-write",
    hasDecisionTools: Boolean(
      cfg.memory.ltm?.enabled && opts.sessionId && workspaceReady,
    ),
    hasPlanningTools: Object.keys(planningTools).length > 0,
    hasOpenVikingTools: Object.keys(openvikingTools).length > 0,
    hasMemorySearch: Object.keys(memorySearchTools).length > 0,
    hasMemoryWriteTools: Object.keys(memoryWriteTools).length > 0,
    hasMcpTools: Object.keys(mcpTools).length > 0,
    hasDelegation: delegationEnabled,
    skills: opts.skills?.map(({ id, name, description }) => ({ id, name, description })),
    requiredSkillIds: opts.requiredSkillIds,
    team: opts.team && teamExecutors.length
      ? {
          name: opts.team.name,
          workflow: opts.team.workflow,
          roles: teamExecutors.map(({ role }) => ({
            id: role.id,
            name: role.name,
            description: role.description,
            model: `${role.target.providerId}/${role.target.model}`,
          })),
        }
      : undefined,
  });

  // Candidate models: primary, gateway-resolved provider fallbacks, then the
  // legacy provider-local model list. Each qualified target carries its own
  // protocol, endpoint, headers, and credentials so secrets never cross an
  // endpoint boundary. Bare legacy model names deliberately stay local.
  const primary = resolveModel(opts.model, {
    baseURL: opts.providerBase,
    id: opts.model,
    provider: opts.providerId,
    protocol: opts.providerProtocol,
  });
  const primaryLimits = sanitizeRuntimeModelLimits(opts.modelLimits);
  const primaryTarget: RuntimeProviderTarget = {
    providerId: opts.providerId ?? primary.provider,
    ...(opts.providerAccountId ? { accountId: opts.providerAccountId } : {}),
    protocol: opts.providerProtocol,
    baseURL: opts.providerBase,
    model: opts.model,
    apiKey: opts.apiKey,
    credentials: providerCredentials,
    ...(opts.providerHeaders ? { headers: opts.providerHeaders } : {}),
    requiresApiKey: opts.requiresApiKey,
    ...(primaryLimits ? { limits: primaryLimits } : {}),
  };
  const legacyTargets: RuntimeProviderTarget[] = cfg.fallbackChain.map((model) => {
    const { limits: _primaryModelLimits, ...providerTarget } = primaryTarget;
    return { ...providerTarget, model };
  });
  const seenTargets = new Set<string>();
  const targets = [primaryTarget, ...(opts.fallbackProviders ?? []), ...legacyTargets].flatMap((target) => {
    const credentials = {
      ...(target.credentials ?? {}),
      ...(!target.credentials?.apiKey && target.apiKey ? { apiKey: target.apiKey } : {}),
    };
    if (target.requiresApiKey !== false && !hasProviderCredentials(target.protocol, credentials)) return [];
    const key = `${target.providerId}\0${target.accountId ?? "primary"}\0${target.model}`;
    if (seenTargets.has(key)) return [];
    seenTargets.add(key);
    const { limits: _untrustedLimits, ...withoutLimits } = target;
    const limits = sanitizeRuntimeModelLimits(target.limits);
    return [{ ...withoutLimits, ...(limits ? { limits } : {}) }];
  });
  const candidates = targets.map((target, index) => ({
    target,
    credentials: {
      ...(target.credentials ?? {}),
      ...(!target.credentials?.apiKey && target.apiKey ? { apiKey: target.apiKey } : {}),
    },
    entry: index === 0
      ? primary
      : resolveModel(target.model, {
          baseURL: target.baseURL,
          id: target.model,
          provider: target.providerId,
          protocol: target.protocol,
        }),
  }));
  const attemptTarget = (candidateIndex: number): ProviderAttemptTarget => {
    const candidate = candidates[candidateIndex];
    if (!candidate) throw new Error("provider_attempt_candidate_invalid");
    return {
      providerId: candidate.target.providerId,
      ...(candidate.target.accountId ? { accountId: candidate.target.accountId } : {}),
      modelId: candidate.entry.id,
    };
  };
  const publicAttempt = (attempt: ProviderStreamAttemptOutcome): ProviderAttemptOutcome => ({
    ...attemptTarget(attempt.candidateIndex),
    outcome: attempt.outcome,
    phase: attempt.phase,
    ...(attempt.statusCode !== undefined ? { statusCode: attempt.statusCode } : {}),
    ...(attempt.retryAfterMs !== undefined ? { retryAfterMs: attempt.retryAfterMs } : {}),
  });
  const publicAttempts = (attempts: ProviderStreamAttemptOutcome[] | undefined): ProviderAttemptOutcome[] => (
    Array.isArray(attempts) ? attempts.map(publicAttempt) : []
  );
  const attemptLifecycle = opts.providerAttemptLifecycle
    ? {
        acquire: (candidateIndex: number): unknown | null => opts.providerAttemptLifecycle!.acquire(attemptTarget(candidateIndex)),
        release: (handle: unknown, outcome: ProviderStreamAttemptOutcome): void => {
          opts.providerAttemptLifecycle!.release(handle, publicAttempt(outcome));
        },
      }
    : undefined;
  const keyPool = new KeyPool({ keys: [opts.apiKey] });
  const explicitWorker = delegationEnabled ? opts.workerProvider : undefined;
  const workerEntry = explicitWorker
    ? resolveModel(explicitWorker.model, {
        baseURL: explicitWorker.baseURL,
        id: explicitWorker.model,
        provider: explicitWorker.providerId,
        protocol: explicitWorker.protocol,
      })
    : undefined;
  const workerCredentials = explicitWorker
    ? {
        ...(explicitWorker.credentials ?? {}),
        ...(!explicitWorker.credentials?.apiKey && explicitWorker.apiKey
          ? { apiKey: explicitWorker.apiKey }
          : {}),
      }
    : undefined;
  const explicitWorkerProviderOptions = explicitWorker
    ? buildProviderOptions(explicitWorker.protocol, undefined)
    : undefined;
  const primaryContextWindowOverride = boundedModelOverride(
    opts.modelParams?.contextWindowOverride,
    "contextWindow",
  );
  const primaryMaxOutputOverride = boundedModelOverride(
    opts.modelParams?.maxOutputOverride,
    "maxOutput",
  );

  const start = (ci: number, useTools: boolean): StreamLike => {
    const candidate = candidates[ci] ?? candidates[0]!;
    const { entry, target, credentials } = candidate;
    // Hermes agent.reasoning_effort: fill default when the turn did not set effort.
    const turnParams = (() => {
      const base = opts.modelParams ?? {};
      const hasEffort = typeof base.effort === "string" && base.effort.trim().length > 0;
      const def = typeof cfg.defaultReasoningEffort === "string" ? cfg.defaultReasoningEffort.trim() : "";
      if (hasEffort || !def || def === "off") return opts.modelParams;
      return { ...base, effort: def };
    })();
    const providerOptions = buildProviderOptions(target.protocol, turnParams);
    // Manual limits are scoped to the selected primary model. A fallback can
    // have a different context/output contract and must use its own registry
    // metadata instead of inheriting an unrelated override.
    const contextWindow = ci === 0
      ? primaryContextWindowOverride ?? target.limits?.contextWindow ?? entry.limits.contextWindow
      : target.limits?.contextWindow ?? entry.limits.contextWindow;
    const maxOutputTokens = ci === 0
      ? primaryMaxOutputOverride ?? target.limits?.maxOutput ?? entry.limits.maxOutput
      : target.limits?.maxOutput ?? entry.limits.maxOutput;
    // Unknown is a real state: without a verified context window Kyrei avoids
    // pretending that a generic 32k budget describes this endpoint.
    const model = buildModel({
      protocol: target.protocol,
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      credentials,
      model: entry.id,
      headers: target.headers,
      ...(ci === 0 && keyPool.isMulti() ? { fetch: keyPool.fetchMiddleware() } : {}),
    });
    const workerModel = explicitWorker
      ? buildModel({
          protocol: explicitWorker.protocol,
          baseURL: explicitWorker.baseURL,
          apiKey: explicitWorker.apiKey,
          credentials: workerCredentials ?? {},
          model: explicitWorker.model,
          headers: explicitWorker.headers,
        })
      : model;
    const prepareStep = ccr && contextWindow !== undefined
      ? makePrepareStep(cfg, {
          model: entry.id,
          window: contextWindow,
          ccr,
          workspace: opts.workspace,
          sessionId: opts.sessionId,
          onMemoryMutated,
          ...(cfg.memory?.ltm?.enabled && opts.workspace ? { ltmDir: join(opts.workspace, "ltm") } : {}),
          // Stage-B LLM summary uses worker when configured; fail-open to heuristic.
          ...(cfg.compression?.summaryUseLlm ? { summaryModel: workerModel } : {}),
        })
      : undefined;
    const delegateTools = buildDelegateTool({
      enabled: delegationEnabled,
      maxTasks: cfg.delegation.maxTasks,
      maxParallel: cfg.delegation.maxParallel,
      abortSignal: opts.abortSignal,
      emit: opts.emit,
      idPrefix: opts.sessionId ? `session:${opts.sessionId}` : undefined,
      runTask: createReadOnlyChildRunner({
        model: workerModel,
        modelId: workerEntry?.id ?? entry.id,
        tools: childTools,
        maxSteps: cfg.delegation.maxSteps,
        maxRetries: cfg.apiMaxRetries,
        timeoutMs: cfg.delegation.timeoutMs,
        cost: workerEntry?.cost ?? entry.cost,
        providerOptions: explicitWorkerProviderOptions ?? providerOptions,
        workspace: workspaceReady ? opts.workspace : undefined,
        skills: opts.skills?.map(({ id, name, description }) => ({ id, name, description })),
        ...(opts.providerAttemptLifecycle
          ? {
              providerAttempt: {
                lifecycle: opts.providerAttemptLifecycle,
                target: {
                  providerId: explicitWorker?.providerId ?? target.providerId,
                  ...((explicitWorker?.accountId ?? target.accountId)
                    ? { accountId: explicitWorker?.accountId ?? target.accountId }
                    : {}),
                  modelId: workerEntry?.id ?? entry.id,
                },
              },
            }
          : {}),
      }),
    });
    const mergedTools: ToolSet = { ...(tools ?? {}), ...delegateTools, ...teamTools };
    const callTools: ToolSet | undefined = useTools && Object.keys(mergedTools).length
      ? mergedTools
      : undefined;
    let guardStopReason: GuardStopReason | undefined;
    const result = streamText({
      model,
      ...(instructions ? { instructions } : {}),
      messages: prepareMessagesForModel((opts.messages ?? []) as ModelMessage[]),
      ...(callTools
        ? {
            tools: callTools,
            stopWhen: buildStopWhen(cfg, (reason) => {
              guardStopReason ??= reason;
            }),
          }
        : {}),
      ...(callTools && workspaceReady
        ? {
            toolApproval: async ({ toolCall, messages }: {
              toolCall: { toolCallId: string; toolName: string; input: unknown };
              messages: import("ai").ModelMessage[];
            }) => {
              // AI SDK validates the stored request HMAC before invoking this
              // callback. Correlate that durable receipt before evaluating the
              // *current* policy so ask→allow/deny changes cannot bypass or
              // strand its one-shot consumption lifecycle.
              const approvalId = approvedApprovalId(messages, toolCall.toolCallId);
              if (approvalId) approvedToolCalls.set(toolCall.toolCallId, approvalId);
              const evaluation = await evaluateToolApproval({
                toolName: toolCall.toolName,
                args: toolCall.input,
                workspace: opts.workspace!,
                config: cfg,
              });
              if (!evaluation || evaluation.decision === "allow") return "not-applicable" as const;
              if (evaluation.decision === "deny") {
                if (approvalId) {
                  approvedToolCalls.delete(toolCall.toolCallId);
                  await consumeApprovedCall(approvalId, toolCall.toolCallId);
                }
                return { type: "denied" as const, reason: evaluation.reason };
              }
              if (!opts.approvalSecret) {
                return { type: "denied" as const, reason: "approval_signing_unavailable" };
              }
              approvalMeta.set(toolCall.toolCallId, {
                reason: evaluation.reason,
                args: redactApprovalArgs(evaluation.args, sensitiveValues),
                name: toolCall.toolName,
              });
              return "user-approval" as const;
            },
            experimental_toolApprovalSecret: opts.approvalSecret,
          }
        : {}),
      ...(callTools && prepareStep ? { prepareStep } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      maxRetries: cfg.apiMaxRetries,
      onError: ({ error }: { error: unknown }) => {
        const message = error instanceof Error ? error.message : String(error ?? "provider_stream_error");
        console.error("[kyrei v2] stream error:", redact(message, sensitiveValues));
      },
    });
    return {
      stream: result.stream,
      responseMessages: result.responseMessages,
      guardStopReason: () => guardStopReason,
    };
  };

  let stream: StreamLike;
  try {
    stream = attemptLifecycle
      ? await openStream(candidates.length, hasTools, start, { attemptLifecycle })
      : await openStream(candidates.length, hasTools, start);
  } catch (error) {
    await releaseMemoryIndex();
    if (mcpManager) await mcpManager.close().catch(() => undefined);
    return throwWithProviderAttempts(error, publicAttempts(streamAttemptsFromError(error)));
  }
  const selected = candidates[stream.candidateIndex ?? 0] ?? candidates[0]!;

  let bridged;
  try {
    bridged = await bridgeStream(stream.stream, opts.emit, {
      toolMeta,
      provider: selected.target.providerId,
      model: selected.entry.id,
      maxSteps: cfg.maxSteps,
      guardStopReason: stream.guardStopReason,
      approvalMeta,
    });
  } catch (error) {
    await releaseMemoryIndex();
    if (mcpManager) await mcpManager.close().catch(() => undefined);
    return throwWithProviderAttempts(error, publicAttempts(stream.attempts));
  }

  let parts: MessagePart[];
  let responseMessages: import("ai").ModelMessage[] | undefined;
  try {
    responseMessages = await stream.responseMessages as import("ai").ModelMessage[];
    parts = toParts(responseMessages, bridged);
  } catch {
    parts = bridged.parts;
  }

  let status = bridged.status;
  let goalVerify: { satisfied: boolean; gap?: string } | undefined;
  let healHandoffPath: string | undefined;
  let fileReview: import("../types.js").FileReviewState | undefined;

  // Self-heal FSM exhausted consecutive hard tool failures → distilled handoff
  // for human / clean-window resume (JSON chat remains SoT).
  if (
    status === "heal_handoff"
    && cfg.reliability?.healHandoff !== false
    && workspaceReady
    && opts.sessionId
    && !opts.abortSignal?.aborted
  ) {
    try {
      const history = [
        ...((opts.messages ?? []) as ModelMessage[]),
        ...(responseMessages ?? []),
      ];
      const artifact = extractHeuristicHandoff(history, opts.sessionId, "heal_handoff");
      artifact.openQuestions = [
        ...artifact.openQuestions,
        "Self-heal FSM reached handoff after consecutive hard tool failures.",
      ];
      artifact.nextActions = artifact.nextActions.length
        ? artifact.nextActions
        : ["Review the last tool errors", "Fix environment or inputs", "Resume from this handoff"];
      healHandoffPath = await writeHandoff(opts.workspace!, artifact);
      console.info(`[kyrei reliability] heal handoff → ${healHandoffPath}`);
      if (cfg.memory?.ltm?.enabled) {
        try {
          const { createLtmBridge } = await import("../memory/ltm-bridge.js");
          const ltm = createLtmBridge(join(opts.workspace!, "ltm"));
          await ltm.appendCheckpoint({
            summary: `Heal handoff after consecutive tool failures: ${artifact.intent}`,
            changedFiles: artifact.keyFiles.map((f) => f.path),
            decisions: [],
            openThreads: artifact.openQuestions,
            nextActions: artifact.nextActions,
            sessionId: opts.sessionId,
          });
        } catch (ltmErr) {
          console.warn("[kyrei reliability] LTM checkpoint for heal handoff skipped:", ltmErr);
        }
      }
      opts.emit({
        type: "message.delta",
        payload: {
          text: `\n\n[heal-handoff] consecutive tool failures — handoff written: ${healHandoffPath}`,
        },
      });
    } catch (error) {
      console.warn("[kyrei reliability] heal handoff write failed:", error);
    }
  }

  // Post-turn goal verifier: only when an explicit goal was provided and the
  // turn otherwise looks successful (or hit step budget).
  if (
    cfg.reliability?.goalVerify !== false
    && opts.goal?.trim()
    && (status === "complete" || status === "max_steps")
    && !opts.abortSignal?.aborted
  ) {
    try {
      const judgeCredentials = {
        ...(selected.target.credentials ?? {}),
        ...(!selected.target.credentials?.apiKey && selected.target.apiKey
          ? { apiKey: selected.target.apiKey }
          : {}),
      };
      const judge = createModelGoalJudge(
        buildModel({
          protocol: selected.target.protocol,
          baseURL: selected.target.baseURL,
          apiKey: selected.target.apiKey,
          credentials: judgeCredentials,
          model: selected.entry.id,
          headers: selected.target.headers,
        }),
        {
          abortSignal: opts.abortSignal,
          maxOutputTokens: 200,
        },
      );
      const transcript = [
        ...snippetsFromModelMessages((opts.messages ?? []) as ModelMessage[], { maxMessages: 12 }),
        { role: "assistant", text: bridged.text },
      ]
        .map((s) => `${s.role}: ${s.text}`)
        .join("\n\n");
      const verdict = await maybeVerifyTurnGoal({
        enabled: true,
        goal: opts.goal,
        transcript,
        judge,
      });
      if (verdict) {
        goalVerify = {
          satisfied: verdict.satisfied,
          ...(verdict.gap ? { gap: verdict.gap } : {}),
        };
        if (!verdict.satisfied && status === "complete") {
          status = "goal_unsatisfied";
          opts.emit({
            type: "message.delta",
            payload: {
              text: `\n\n[goal-verify] цель не подтверждена: ${verdict.gap ?? "gap unknown"}`,
            },
          });
        }
      }
    } catch (error) {
      console.warn("[kyrei reliability] goal verify skipped:", error);
    }
  }

  // Supervised mode (Kiro analogue): after file-modifying tools, pause for
  // accept/reject. Reject restores pre-turn snapshots. Autopilot skips this gate.
  if (
    cfg.executionMode === "supervised"
    && canEnterFileReview(status)
    && !opts.abortSignal?.aborted
  ) {
    const review = collectFileReviewFromParts(parts);
    if (review) {
      fileReview = review;
      status = "awaiting_file_review";
      opts.emit({
        type: "message.delta",
        payload: {
          text: `\n\n[supervised] ${review.files.length} file change(s) pending review — accept or reject before continuing.`,
        },
      });
    }
  }

  await releaseMemoryIndex();
  if (mcpManager) {
    try {
      await mcpManager.close();
    } catch {
      /* ignore */
    }
  }
  return {
    text: bridged.text,
    parts,
    status,
    ...(responseMessages?.length ? { responseMessages } : {}),
    attempts: publicAttempts(stream.attempts),
    route: {
      providerId: selected.target.providerId,
      modelId: selected.entry.id,
      ...(selected.target.accountId ? { accountId: selected.target.accountId } : {}),
    },
    ...(goalVerify ? { goalVerify } : {}),
    ...(healHandoffPath ? { healHandoffPath } : {}),
    ...(fileReview ? { fileReview } : {}),
  };
}
