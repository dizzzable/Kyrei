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
  KyreiEvent,
  MessagePart,
  ProviderAttemptOutcome,
  ProviderAttemptTarget,
  RuntimeModelLimits,
  RuntimeProviderTarget,
  Usage,
} from "../types.js";
import {
  buildModel,
  buildProviderOptions,
  hasProviderCredentials,
  resolveTurnModelParams,
} from "../provider/build.js";
import { resolveEngineConfig } from "../config/schema.js";
import { resolve as resolveModel } from "../provider/registry.js";
import { KeyPool } from "../provider/keys.js";
import {
  normalizeSubscriptionShield,
  shouldHideEngineIdentity,
  wrapFetchWithSubscriptionShield,
} from "../provider/subscription-shield.js";
import {
  openStream,
  streamAttemptsFromError,
  type ProviderStreamAttemptOutcome,
  type StreamLike,
} from "../provider/open-stream.js";
import {
  effectiveCodingModeFromMessages,
  filterToolsForCodingMode,
  isPlanModeBlockedTool,
  normalizeCodingMode,
} from "../coding-mode.js";
import { buildTools, type ToolMeta } from "../tools/index.js";
import { buildWebTools } from "../tools/web.js";
import { buildGBrainTools } from "../tools/gbrain.js";
import { buildPlanningTools } from "../tools/planning.js";
import { buildOpenVikingTools } from "../tools/openviking.js";
import { buildMemorySearchTools } from "../tools/memory-search.js";
import { buildMemoryAskTools } from "../tools/memory-ask.js";
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
import { createReadMemo } from "../context/read-memo.js";
import { lastUserTextFromMessages } from "../context/goal-skim.js";
import { classifyIntentFromMessages } from "../context/intent-router.js";
import { shouldForcePlanMode } from "../context/plan-gate.js";
import { createHarnessMetrics } from "../observability/harness-metrics.js";
import { buildBudgetedSymbolMap, symbolMapLastWasCacheHit } from "../intel/repo-symbols.js";
import { assembleSystemContext } from "../memory/layers.js";
import { buildAutomaticRecallContext } from "../memory/auto-recall.js";
import { MemoryIndexSession } from "../memory/index-session.js";
import { snippetsFromModelMessages } from "../memory/session-project.js";
import { configureEmbedAdapterFromConfig } from "../memory/embed-adapter.js";
import { createStores, type Stores } from "../data/index.js";
import {
  createModelGoalJudge,
  maybeVerifyTurnGoal,
  prepareMessagesForModel,
} from "../reliability/runtime.js";
import {
  formatPostEditVerifyAppendix,
  runPostEditVerify,
} from "../reliability/post-edit-verify.js";
import {
  evaluateVerifyBeforeDone,
} from "../reliability/verify-before-done.js";
import { collectFileReviewFromParts, canEnterFileReview } from "../reliability/file-review.js";
import { extractHeuristicHandoff, writeHandoff } from "../memory/handoff.js";
import { buildSystemPromptParts } from "./system-prompt.js";
import { mergeProviderOptions, packSystemForCache } from "../prompt/cache-packing.js";
import type { ToolName } from "../prompt/tool-descriptions.js";
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

// A provider's context window covers the prompt *and* the requested completion.
// Keep room for the completion plus stable system/tool protocol overhead before
// deciding whether history must be compacted. Without this reserve a large first
// request can be rejected before AI SDK ever invokes prepareStep.
const CONTEXT_PROTOCOL_RESERVE_TOKENS = 8_192;

function inputContextWindow(contextWindow: number, maxOutputTokens: number | undefined): number {
  const reserved = Math.min(
    Math.max(0, contextWindow - MODEL_OVERRIDE_BOUNDS.contextWindow.min),
    (maxOutputTokens ?? 0) + CONTEXT_PROTOCOL_RESERVE_TOKENS,
  );
  return Math.max(MODEL_OVERRIDE_BOUNDS.contextWindow.min, contextWindow - reserved);
}

/**
 * Keep an OpenAI Responses cache namespace stable for one durable chat. The
 * model id prevents unrelated model routes from sharing an opaque cache key.
 * OpenAI-compatible gateways are intentionally excluded: many do not accept
 * this vendor-specific field and already control their own caching behavior.
 */
function sessionPromptCacheOptions(
  protocol: RuntimeProviderTarget["protocol"],
  sessionId: string | undefined,
  model: string,
) {
  if (protocol !== "openai-responses" || !sessionId) return undefined;
  const clean = (value: string, max: number) => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, max);
  return {
    openai: {
      promptCacheKey: `kyrei:v2:${clean(sessionId, 96)}:${clean(model, 96)}`,
    },
  };
}

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

async function runKyreiChatPass(opts: RunKyreiChatOpts): Promise<RunKyreiChatResult> {
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
  /** Wave B4: turn-scoped path@hash memo for repeated read_file. */
  const readMemo = createReadMemo();
  const audit = opts.auditLogPath ? createAuditLog(opts.auditLogPath) : undefined;
  const harnessMetrics = createHarnessMetrics({
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });

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
        ...(cfg.memory.vault ? { vault: cfg.memory.vault } : {}),
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
  /** project_index must land graph-lite in FTS before the tool returns (OOB). */
  const flushMemoryIndex = async (): Promise<void> => {
    if (!memoryIndex) return;
    memoryIndex.notifyMutated();
    await memoryIndex.reindexNow();
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

  // Subscription shield: pace + soft TLS/header hygiene for expensive seats.
  // Gateway-owned config only — never taken from renderer chat payload.
  const subscriptionShield = normalizeSubscriptionShield(opts.subscriptionShield);
  const hideEngineIdentity = shouldHideEngineIdentity(subscriptionShield);
  const providerFetchFor = (paceKey?: string, baseFetch?: typeof fetch): typeof fetch | undefined => {
    const shieldFetch = wrapFetchWithSubscriptionShield({
      config: subscriptionShield,
      paceKey: paceKey || opts.providerAccountId || "primary",
      ...(baseFetch ? { baseFetch } : {}),
    });
    return shieldFetch ?? baseFetch;
  };

  // Clean-context reviewer (Requirements §11.3) reuses the primary provider's
  // credentials/endpoint — no separate account is provisioned for it. It is
  // an isolated *call* (fresh messages, no tools, no history), not a
  // separate identity, so it never needs its own credential surface.
  const reviewFetch = providerFetchFor(opts.providerAccountId || "primary");
  const reviewModel = cfg.review?.cleanContext
    ? buildModel({
        protocol: opts.providerProtocol,
        baseURL: opts.providerBase,
        apiKey: opts.apiKey,
        credentials: providerCredentials,
        model: opts.model,
        headers: opts.providerHeaders,
        identifyEngine: !hideEngineIdentity,
        ...(reviewFetch ? { fetch: reviewFetch } : {}),
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
        flushMemoryIndex,
        onLtmEvent,
        ...(cfg.memory.ltm?.enabled ? { ltmDir: join(opts.workspace!, "ltm") } : {}),
        ...(reviewModel ? { reviewModel } : {}),
        readMemo,
        smartCompress: true,
        codingMode: normalizeCodingMode(cfg.codingMode),
        onPostEditVerify: (ok) => harnessMetrics.recordPostEditVerify(ok),
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
    ...(opts.globalMemoryDir ? { dataDir: opts.globalMemoryDir } : {}),
    sensitiveValues,
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
        ...(cfg.memory.vault?.enabled ? { vault: cfg.memory.vault } : {}),
        ...(cfg.memory.recall ? { recall: cfg.memory.recall } : {}),
        ...(cfg.memory.citeOrRefuse
          ? {
              citeOrRefuse: {
                enabled: cfg.memory.citeOrRefuse.enabled,
                minTopScore: cfg.memory.citeOrRefuse.minTopScore,
                minHits: cfg.memory.citeOrRefuse.minHits,
              },
            }
          : {}),
      })
    : {};
  const memoryAskTools = workspaceReady
    ? buildMemoryAskTools({
        workspace: opts.workspace!,
        ...(cfg.memory.ltm?.enabled ? { ltmDir: join(opts.workspace!, "ltm"), ltmEnabled: true } : { ltmEnabled: false }),
        maxModelOutputChars: cfg.maxToolOutput,
        ...(cfg.memory.vault?.enabled ? { vault: cfg.memory.vault } : {}),
        citeOrRefuse: {
          minTopScore: cfg.memory.citeOrRefuse?.minTopScore ?? 4,
          minHits: cfg.memory.citeOrRefuse?.minHits ?? 1,
        },
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
      ? createMcpManager({
          config: mcpConfig,
          ...(opts.workspace ? { workspace: opts.workspace } : {}),
          sensitiveValues,
        })
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
    ...(opts.readSkill ? { readSkill: opts.readSkill } : {}),
    ...(opts.readSkillDocument ? { readDocument: opts.readSkillDocument } : {}),
  });
  // Delegates receive a separately constructed reader without the parent's
  // usage callback. Loading instructions must remain a read-only child action.
  const childSkillTools = buildSkillTools(opts.skills ?? [], {
    maxOutputChars: cfg.maxToolOutput,
    ...(opts.readSkill ? { readSkill: opts.readSkill } : {}),
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
    ...memoryAskTools,
    ...memoryWriteTools,
    ...mcpTools,
    ...skillTools,
  };
  // Plan mode hard-gates mutating tools (edit/write/shell/MCP write surfaces).
  // Wave D3: long-horizon auto goals force plan tools until plan exists / user authorizes build.
  const configuredCodingMode = normalizeCodingMode(cfg.codingMode);
  const intent = classifyIntentFromMessages(
    (opts.messages ?? []) as Array<{ role?: string; content?: unknown }>,
    opts.goal,
  );
  const forcePlan = workspaceReady
    && await shouldForcePlanMode({
      codingMode: configuredCodingMode,
      longTaskPlanGate: cfg.reliability?.longTaskPlanGate !== false,
      workspace: opts.workspace,
      messages: (opts.messages ?? []) as Array<{ role?: string; content?: unknown }>,
      ...(opts.goal ? { goal: opts.goal } : {}),
    });
  harnessMetrics.recordIntent(intent.route, intent.reason);
  if (forcePlan) harnessMetrics.recordLongTaskPlanGate();
  const effectiveStartMode = forcePlan ? "plan" as const : configuredCodingMode;
  const filteredToolSet = filterToolsForCodingMode(
    baseToolSet as Record<string, unknown>,
    effectiveStartMode,
  ) as ToolSet | undefined;
  const tools = filteredToolSet && Object.keys(filteredToolSet).length ? filteredToolSet : undefined;
  // MCP is intentionally not available to read-only children (external process surface).
  const childTools = selectReadOnlyChildTools(
    workspaceTools,
    retrieveTools,
    webTools,
    brainTools,
    planningTools,
    openvikingTools,
    memorySearchTools,
    memoryAskTools,
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
        ...(cfg.memory?.decay ? { decay: cfg.memory.decay } : {}),
      });
      projectContext = assembled.trim() ? assembled : undefined;
      if (memoryIndex?.memoryStore) {
        const recalled = await buildAutomaticRecallContext({
          query: lastUserTextFromMessages(opts.messages ?? []),
          memory: memoryIndex.memoryStore,
          limit: Math.min(4, cfg.memory.recall?.k ?? 4),
          maxChars: 3_200,
        });
        if (recalled) projectContext = projectContext ? `${projectContext}\n\n${recalled}` : recalled;
      }
      // Wave D4: budgeted symbol map (fail-open; complements import graph tools).
      try {
        const symbolMap = await buildBudgetedSymbolMap(opts.workspace!, { maxChars: 1_600 });
        if (symbolMapLastWasCacheHit(opts.workspace!)) {
          harnessMetrics.recordSymbolMapCacheHit();
        }
        if (symbolMap.trim()) {
          projectContext = projectContext
            ? `${projectContext}\n\n${symbolMap}`
            : symbolMap;
        }
      } catch (mapErr) {
        console.warn("[kyrei v2] symbol map skipped:", mapErr);
      }
    } catch (error) {
      console.warn("[kyrei v2] project context disabled:", error);
    }
  }

  // A continuation is intentionally a system-context reference rather than a
  // hidden chat message. This keeps strict provider message alternation intact
  // and lets the normal project/plan/LTM layers remain the current source of
  // truth. The gateway bounds and redacts this packet before it reaches here.
  if (opts.continuationContext?.trim()) {
    projectContext = projectContext
      ? `${opts.continuationContext.trim()}\n\n${projectContext}`
      : opts.continuationContext.trim();
  }

  // Effort for Team is resolved inside createTeamRoleExecutors from cfg + modelParams.
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
        codingMode: effectiveStartMode,
        sensitiveValues,
        emit: opts.emit,
        onSkillUsed: opts.onSkillUsed,
        ...(opts.readSkill ? { readSkill: opts.readSkill } : {}),
        ...(opts.readSkillDocument ? { readSkillDocument: opts.readSkillDocument } : {}),
        providerAttemptLifecycle: opts.providerAttemptLifecycle,
        ...(memoryIndex?.memoryStore ? { memoryStore: memoryIndex.memoryStore } : {}),
        ...(memoryIndex?.vectorStore ? { vectorStore: memoryIndex.vectorStore } : {}),
        indexBackend: memoryIndex?.backendLabel ?? "off",
        ...(opts.globalMemoryDir ? { globalMemoryDir: opts.globalMemoryDir } : {}),
        modelParams: opts.modelParams,
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
  const promptToolRecord = filterToolsForCodingMode({
    ...(tools ?? {}),
    ...(delegationEnabled ? { delegate_read: true } : {}),
    ...teamTools,
  }, effectiveStartMode) ?? {};
  const availableToolNames = Object.keys(promptToolRecord) as ToolName[];
  const systemParts = buildSystemPromptParts({
    workspace: opts.workspace,
    hasTools,
    availableToolNames,
    personality: resolvePersonalityText({
      personality: cfg.personality,
      personalityPresetId: cfg.personalityPresetId,
    }),
    // When long-task plan gate forces plan tools, prompt must match (not stay on auto).
    codingMode: forcePlan ? "plan" : cfg.codingMode,
    timezone: cfg.timezone,
    promptProfile: cfg.promptProfiles.find((profile) => profile.id === cfg.activePromptProfileId)?.systemPrompt,
    projectContext,
    hasBrainTools: Object.keys(brainTools).length > 0,
    hasBrainWriteTools: Object.hasOwn(brainTools, "brain_capture"),
    // Reads (query/fetch) work without sessionId; writes need sessionId but policy still useful.
    hasDecisionTools: Boolean(cfg.memory.ltm?.enabled && workspaceReady),
    hasPlanningTools: Object.keys(planningTools).length > 0,
    hasOpenVikingTools: Object.keys(openvikingTools).length > 0,
    hasMemorySearch: Object.keys(memorySearchTools).length > 0 || Object.keys(memoryAskTools).length > 0,
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
  // Wave B2: pack stable system prefix for prompt-cache (Anthropic breakpoints).
  // Protocol is known at stream start; pack per-candidate inside start().

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
    ...(attempt.failureClass !== undefined ? { failureClass: attempt.failureClass } : {}),
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
  // Shared turn params (effort/defaultReasoningEffort) for main, worker, and Team.
  const turnParams = resolveTurnModelParams(opts.modelParams, cfg.defaultReasoningEffort);
  const explicitWorkerProviderOptions = explicitWorker
    ? buildProviderOptions(explicitWorker.protocol, turnParams)
    : undefined;
  const primaryContextWindowOverride = boundedModelOverride(
    opts.modelParams?.contextWindowOverride,
    "contextWindow",
  );
  const primaryMaxOutputOverride = boundedModelOverride(
    opts.modelParams?.maxOutputOverride,
    "maxOutput",
  );

  const start = async (ci: number, useTools: boolean): Promise<StreamLike> => {
    const candidate = candidates[ci] ?? candidates[0]!;
    const { entry, target, credentials } = candidate;
    const providerOptions = mergeProviderOptions(
      buildProviderOptions(target.protocol, turnParams),
      sessionPromptCacheOptions(target.protocol, opts.sessionId, entry.id),
    );
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
    const paceKey = target.accountId || opts.providerAccountId || `candidate-${ci}`;
    const shieldFetch = providerFetchFor(paceKey);
    const multiKeyFetch = ci === 0 && keyPool.isMulti()
      ? keyPool.fetchMiddleware(shieldFetch ?? globalThis.fetch.bind(globalThis))
      : undefined;
    const modelFetch = multiKeyFetch ?? shieldFetch;
    const model = buildModel({
      protocol: target.protocol,
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      credentials,
      model: entry.id,
      headers: target.headers,
      identifyEngine: !hideEngineIdentity,
      ...(modelFetch ? { fetch: modelFetch } : {}),
    });
    const workerShieldFetch = explicitWorker
      ? providerFetchFor(explicitWorker.accountId || "worker")
      : undefined;
    const workerModel = explicitWorker
      ? buildModel({
          protocol: explicitWorker.protocol,
          baseURL: explicitWorker.baseURL,
          apiKey: explicitWorker.apiKey,
          credentials: workerCredentials ?? {},
          model: explicitWorker.model,
          headers: explicitWorker.headers,
          identifyEngine: !hideEngineIdentity,
          ...(workerShieldFetch ? { fetch: workerShieldFetch } : {}),
        })
      : model;
    const compactionWindow = contextWindow !== undefined
      ? inputContextWindow(contextWindow, maxOutputTokens)
      : undefined;
    const compactionPrepareStep = ccr && compactionWindow !== undefined
      ? makePrepareStep(cfg, {
          model: entry.id,
          window: compactionWindow,
          ccr,
          workspace: opts.workspace,
          sessionId: opts.sessionId,
          onMemoryMutated,
          metrics: harnessMetrics,
          ...(opts.goal ? { goal: opts.goal } : {}),
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
        idleTimeoutMs: cfg.delegation.idleTimeoutMs,
        maxRuntimeMs: cfg.delegation.maxRuntimeMs,
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
    // Merge first, then re-apply plan filter so team_delegate cannot reappear
    // after filterToolsForCodingMode stripped it from the base set.
    const mergedRaw: ToolSet = { ...(tools ?? {}), ...delegateTools, ...teamTools };
    const configuredMode = forcePlan ? "plan" as const : normalizeCodingMode(cfg.codingMode);
    const mergedTools: ToolSet = (
      filterToolsForCodingMode(mergedRaw as Record<string, unknown>, configuredMode) ?? {}
    ) as ToolSet;
    const callTools: ToolSet | undefined = useTools && Object.keys(mergedTools).length
      ? mergedTools
      : undefined;
    /** Plan-safe subset used when auto declares Effective phase: plan mid-turn. */
    const planActiveToolNames = callTools
      ? (Object.keys(
        filterToolsForCodingMode(callTools as Record<string, unknown>, "plan") ?? {},
      ) as Array<keyof ToolSet & string>)
      : [];
    // Mid-turn: when UI mode is auto and the model declared plan, narrow tools
    // for subsequent steps. Also runs compaction prepareStep when present.
    const prepareStep = callTools
      ? async (stepOpts: {
          messages: ModelMessage[];
          steps?: ReadonlyArray<{ usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; promptTokens?: number } }>;
          stepNumber?: number;
        }) => {
          const compacted = compactionPrepareStep
            ? await compactionPrepareStep(stepOpts)
            : undefined;
          const messages = compacted?.messages ?? stepOpts.messages;
          const effective = forcePlan
            ? "plan" as const
            : effectiveCodingModeFromMessages(messages, configuredMode);
          if (effective === "plan" && planActiveToolNames.length) {
            return {
              ...(compacted ?? {}),
              messages,
              activeTools: planActiveToolNames,
            };
          }
          return compacted;
        }
      : compactionPrepareStep;
    let guardStopReason: GuardStopReason | undefined;
    // Wave B2: Anthropic gets system messages with cacheControl on the stable
    // prefix; other protocols keep a single instructions string (stable first).
    const packedSystem = packSystemForCache(systemParts, target.protocol);
    if (packedSystem.cacheBreakpoints) harnessMetrics.recordCacheBreakpoints(true);
    const rawHistoryMessages = prepareMessagesForModel((opts.messages ?? []) as ModelMessage[]);
    // AI SDK calls prepareStep only after the first provider response/tool step.
    // Run the same compactor before streamText so a long restored session never
    // sends an unbounded first prompt and takes the whole dialog down with it.
    let historyMessages = rawHistoryMessages;
    if (compactionPrepareStep) {
      try {
        const prepared = await compactionPrepareStep({ messages: rawHistoryMessages });
        historyMessages = prepared?.messages ?? rawHistoryMessages;
      } catch (error) {
        // Context preparation is a resilience layer. A degraded index/CCR must
        // not turn a recoverable provider request into a gateway crash.
        console.warn("[kyrei context] initial compaction skipped:", error);
      }
    }
    const streamMessages = packedSystem.systemMessages?.length
      ? [...packedSystem.systemMessages, ...historyMessages]
      : historyMessages;
    const result = streamText({
      model,
      ...(packedSystem.instructions ? { instructions: packedSystem.instructions } : {}),
      messages: streamMessages,
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
              // Hard-deny mutating tools when plan is configured, long-task gate, or auto declared plan.
              const effective = forcePlan
                ? "plan" as const
                : effectiveCodingModeFromMessages(messages, configuredMode);
              if (effective === "plan" && isPlanModeBlockedTool(toolCall.toolName)) {
                return { type: "denied" as const, reason: "plan_mode_blocks_mutating_tools" };
              }
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
  let goalVerify: { satisfied: boolean; gap?: string; unavailable?: boolean } | undefined;
  let healHandoffPath: string | undefined;
  let fileReview: import("../types.js").FileReviewState | undefined;

  // Self-heal exhausted this bounded pass: persist a distilled checkpoint.
  // The outer recovery loop consumes the result and continues automatically.
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
    } catch (error) {
      console.warn("[kyrei reliability] heal handoff write failed:", error);
    }
  }

  // Post-turn goal verifier: explicit goal, Wave D3 polish/audit, or Wave E intent preferGoalVerify.
  const derivedUserGoal = lastUserTextFromMessages((opts.messages ?? []) as Array<{ role?: string; content?: unknown }>);
  const verifyFromUser = cfg.reliability?.goalVerifyFromUserTurn !== false
    && !opts.goal?.trim()
    && (
      normalizeCodingMode(cfg.codingMode) === "polish"
      || intent.preferGoalVerify
      || /KYREI_FINAL_AUDIT|KYREI_RUN_COMPLETE/.test(bridged.text)
    )
    && derivedUserGoal.length >= 12;
  const goalForVerify = opts.goal?.trim() || (verifyFromUser ? derivedUserGoal : "");
  if (
    cfg.reliability?.goalVerify !== false
    && goalForVerify
    && (status === "complete" || status === "max_steps")
    && !opts.abortSignal?.aborted
  ) {
    try {
      harnessMetrics.recordGoalVerify();
      // Wave F3: prefer cheap worker assignment for goal judge (isolated from main chat model).
      const worker = opts.workerProvider;
      const judgeTarget = worker ?? selected.target;
      const judgeEntry = worker
        ? resolveModel(worker.model, {
            baseURL: worker.baseURL,
            id: worker.model,
            provider: worker.providerId,
            protocol: worker.protocol,
          })
        : selected.entry;
      const judgeCredentials = {
        ...(judgeTarget.credentials ?? {}),
        ...(!judgeTarget.credentials?.apiKey && judgeTarget.apiKey
          ? { apiKey: judgeTarget.apiKey }
          : {}),
      };
      const judgeFetch = providerFetchFor(judgeTarget.accountId || opts.providerAccountId || "judge");
      const judge = createModelGoalJudge(
        buildModel({
          protocol: judgeTarget.protocol,
          baseURL: judgeTarget.baseURL,
          apiKey: judgeTarget.apiKey,
          credentials: judgeCredentials,
          model: judgeEntry.id,
          headers: judgeTarget.headers,
          identifyEngine: !hideEngineIdentity,
          ...(judgeFetch ? { fetch: judgeFetch } : {}),
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
        goal: goalForVerify,
        transcript,
        judge,
      });
      if (verdict) {
        if (verdict.unavailable) {
          goalVerify = { satisfied: false, unavailable: true };
          console.warn("[kyrei reliability] goal verifier unavailable; semantic gate skipped");
        } else {
          goalVerify = {
            satisfied: verdict.satisfied,
            ...(verdict.gap ? { gap: verdict.gap } : {}),
          };
          if (!verdict.satisfied && status === "complete") {
            status = "goal_unsatisfied";
          }
        }
      }
    } catch (error) {
      console.warn("[kyrei reliability] goal verify skipped:", error);
    }
  }

  // Wave G1 / G1.1: mutations without verify evidence cannot stay pure "complete".
  // If mid-turn post-edit was skipped, try one fail-open harness verify before blocking.
  if (
    cfg.reliability?.verifyBeforeDone !== false
    && !opts.abortSignal?.aborted
  ) {
    const codingModeNow = normalizeCodingMode(cfg.codingMode);
    let partsForGate = parts as Array<{ type?: string; name?: string; result?: string; error?: string }>;
    let gate = evaluateVerifyBeforeDone({
      enabled: true,
      status,
      codingMode: codingModeNow,
      parts: partsForGate,
      assistantText: bridged.text,
    });

    if (
      gate.blocked
      && workspaceReady
      && opts.workspace
      && cfg.reliability?.postEditVerify !== "off"
    ) {
      try {
        const rescue = await runPostEditVerify({
          workspace: opts.workspace,
          mode: cfg.reliability?.postEditVerify ?? "mutate",
          codingMode: codingModeNow,
          timeoutMs: Math.min(cfg.commandTimeoutMs ?? 60_000, 90_000),
          force: true,
        });
        if (rescue.ran) {
          harnessMetrics.recordPostEditVerify(rescue.ok === true);
          const appendix = formatPostEditVerifyAppendix(rescue);
          if (appendix) {
            opts.emit({ type: "message.delta", payload: { text: appendix } });
          }
          // Successful typecheck/tests satisfy the gate; failures keep blocked.
          if (rescue.ok) {
            partsForGate = [
              ...partsForGate,
              {
                type: "tool",
                name: "diagnostics",
                result: `[post-edit-verify ok] ${rescue.command ?? "verify"}\n${rescue.output ?? ""}`,
              },
            ];
            gate = evaluateVerifyBeforeDone({
              enabled: true,
              status,
              codingMode: codingModeNow,
              parts: partsForGate,
              assistantText: bridged.text,
            });
          } else if (rescue.command) {
            // Record failed verify as explicit gap (still not complete).
            goalVerify = {
              satisfied: false,
              gap: `post_edit_verify_failed:${rescue.command}`,
            };
          }
        }
      } catch (rescueErr) {
        console.warn("[kyrei reliability] end-of-turn verify rescue skipped:", rescueErr);
      }
    }

    if (gate.blocked) {
      status = "goal_unsatisfied";
      try {
        harnessMetrics.recordGoalVerify();
      } catch {
        /* */
      }
      if (!goalVerify || goalVerify.unavailable) {
        goalVerify = {
          satisfied: false,
          gap: "mutations_without_verify_evidence",
        };
      }
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
  const usageFromBridge = bridged.usage;
  const costUsd = usageFromBridge
    && (usageFromBridge.inputTokens !== undefined || usageFromBridge.outputTokens !== undefined)
    ? ((usageFromBridge.inputTokens ?? 0) * selected.entry.cost.inputPerM
      + (usageFromBridge.outputTokens ?? 0) * selected.entry.cost.outputPerM) / 1_000_000
    : undefined;
  const usage = usageFromBridge
    ? { ...usageFromBridge, ...(costUsd !== undefined ? { costUsd } : {}) }
    : undefined;

  const harnessSnapshot = harnessMetrics.snapshot();
  try {
    harnessMetrics.log("end");
  } catch {
    /* metrics must never fail the turn */
  }

  return {
    text: bridged.text,
    parts,
    status,
    harness: harnessSnapshot,
    ...(responseMessages?.length ? { responseMessages } : {}),
    attempts: publicAttempts(stream.attempts),
    route: {
      providerId: selected.target.providerId,
      modelId: selected.entry.id,
      ...(selected.target.accountId ? { accountId: selected.target.accountId } : {}),
    },
    ...(usage ? { usage } : {}),
    ...(goalVerify ? { goalVerify } : {}),
    ...(healHandoffPath ? { healHandoffPath } : {}),
    ...(fileReview ? { fileReview } : {}),
  };
}

const INTERNAL_RECOVERY_STATUSES = new Set<RunKyreiChatResult["status"]>([
  "max_steps",
  "heal_handoff",
  "goal_unsatisfied",
]);

const PRIVATE_RECOVERY_MARKERS = [
  "KYREI_FAILURE_PROBE",
  "KYREI_FAILURE_ESCALATE",
  "KYREI_FAILURE_HANDOFF",
] as const;

function stripPrivateRecoveryMarkers(text: string): string {
  return PRIVATE_RECOVERY_MARKERS.reduce(
    (clean, marker) => clean.replaceAll(marker, ""),
    text,
  );
}

function createRecoveryDeltaFilter(): { push(delta: string): string; flush(): string } {
  let carry = "";
  const suffixToKeep = (text: string): number => {
    let keep = 0;
    for (const marker of PRIVATE_RECOVERY_MARKERS) {
      const max = Math.min(text.length, marker.length - 1);
      for (let length = max; length > keep; length -= 1) {
        if (marker.startsWith(text.slice(-length))) {
          keep = length;
          break;
        }
      }
    }
    return keep;
  };
  return {
    push(delta) {
      const combined = carry + delta;
      const keep = suffixToKeep(combined);
      const ready = keep ? combined.slice(0, -keep) : combined;
      carry = keep ? combined.slice(-keep) : "";
      return stripPrivateRecoveryMarkers(ready);
    },
    flush() {
      const ready = stripPrivateRecoveryMarkers(carry);
      carry = "";
      return ready;
    },
  };
}

function stripRecoveryMarkersFromParts(incoming: readonly MessagePart[]): MessagePart[] {
  const clean: MessagePart[] = [];
  for (const part of incoming) {
    if (part.type !== "text" && part.type !== "reasoning") {
      clean.push({ ...part });
      continue;
    }
    const text = stripPrivateRecoveryMarkers(part.text);
    if (text) clean.push({ ...part, text });
  }

  return clean;
}

function mergeRecoveryParts(current: MessagePart[], incoming: readonly MessagePart[]): MessagePart[] {
  const merged = [...current];
  for (const part of incoming) {
    const previous = merged.at(-1);
    if (
      previous
      && (part.type === "text" || part.type === "reasoning")
      && previous.type === part.type
      && (part.type === "text"
        || (previous.type === "reasoning"
          && previous.id === part.id
          && previous.attempt === part.attempt))
    ) {
      previous.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

function sumUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left && !right) return undefined;
  const sum = (key: keyof Usage): number | undefined => {
    const leftValue = left?.[key];
    const rightValue = right?.[key];
    return leftValue === undefined && rightValue === undefined
      ? undefined
      : (leftValue ?? 0) + (rightValue ?? 0);
  };
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  const explicitTotal = sum("totalTokens");
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined
  );
  const costUsd = sum("costUsd");
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function recoveryBudgetReached(opts: RunKyreiChatOpts, usage: Usage | undefined): boolean {
  if (!usage) return false;
  const cfg = resolveEngineConfig(opts.config).config;
  const maxTokens = cfg.reliability?.maxTokens;
  const maxCostUsd = cfg.reliability?.maxCostUsd;
  return (maxTokens !== undefined && (usage.totalTokens ?? 0) >= maxTokens)
    || (maxCostUsd !== undefined && (usage.costUsd ?? 0) >= maxCostUsd);
}

function recoveryDirective(
  result: RunKyreiChatResult,
  passNumber: number,
  originalGoal: string,
): ModelMessage {
  const gap = result.goalVerify?.gap?.trim().slice(0, 2_000);
  const strategy = result.status === "heal_handoff"
    ? "Inspect the latest tool errors, change the failed preconditions or approach, and do not repeat an identical failing call."
    : result.status === "goal_unsatisfied"
      ? `The completion gate found unfinished work${gap ? `: ${gap}` : "."} Resolve it with concrete actions and verification.`
      : "The execution window ended. Continue from the accumulated progress and finish the remaining work with verification.";
  return {
    role: "user",
    content: [
      `[Kyrei engine recovery checkpoint ${passNumber}; not a new user request and not user-visible.]`,
      "Continue the original task autonomously. Do not present this checkpoint as completion and do not ask whether to continue.",
      strategy,
      ...(originalGoal ? [`Original user goal: ${originalGoal.slice(0, 4_000)}`] : []),
    ].join("\n"),
  };
}

/**
 * Run one logical user turn across as many bounded model windows as necessary.
 * Guardrails stop a bad loop/window; only external blockers, explicit budgets,
 * approvals/review, cancellation, or genuine completion terminate the turn.
 */
export async function runKyreiChat(opts: RunKyreiChatOpts): Promise<RunKyreiChatResult> {
  let messages = [...((opts.messages ?? []) as ModelMessage[])];
  const originalGoal = opts.goal?.trim() || lastUserTextFromMessages(messages);
  let text = "";
  let parts: MessagePart[] = [];
  let responseMessages: ModelMessage[] = [];
  let attempts: ProviderAttemptOutcome[] = [];
  let usage: Usage | undefined;
  let passNumber = 0;

  while (true) {
    passNumber += 1;
    const completedUsage = usage;
    const deltaFilter = createRecoveryDeltaFilter();
    let result: RunKyreiChatResult;
    try {
      result = await runKyreiChatPass({
        ...opts,
        messages,
        ...(originalGoal ? { goal: originalGoal } : {}),
        emit: (event: KyreiEvent) => {
          if (event.type === "message.complete") return;
          if (event.type === "message.delta") {
            const safeText = deltaFilter.push(event.payload.text);
            if (safeText) opts.emit({ ...event, payload: { text: safeText } });
            return;
          }
          if (event.type === "status.update" && event.payload.usage) {
            opts.emit({
              ...event,
              payload: {
                ...event.payload,
                usage: sumUsage(completedUsage, event.payload.usage),
              },
            });
            return;
          }
          opts.emit(event);
        },
      });
    } catch (error) {
      const tail = deltaFilter.flush();
      if (tail) opts.emit({ type: "message.delta", payload: { text: tail } });
      throw error;
    }
    const tail = deltaFilter.flush();
    if (tail) opts.emit({ type: "message.delta", payload: { text: tail } });

    text += stripPrivateRecoveryMarkers(result.text);
    parts = mergeRecoveryParts(parts, stripRecoveryMarkersFromParts(result.parts));
    attempts = [...attempts, ...result.attempts];
    usage = sumUsage(usage, result.usage);
    const passResponseMessages = result.responseMessages?.length
      ? result.responseMessages
      : result.text
        ? [{ role: "assistant", content: result.text } satisfies ModelMessage]
        : [];
    responseMessages = [...responseMessages, ...passResponseMessages];

    const budgetReached = recoveryBudgetReached(opts, usage);
    const shouldRecover = INTERNAL_RECOVERY_STATUSES.has(result.status)
      && !budgetReached
      && !opts.abortSignal?.aborted;
    if (shouldRecover) {
      messages = [
        ...messages,
        ...passResponseMessages,
        recoveryDirective(result, passNumber, originalGoal),
      ];
      continue;
    }

    const status = budgetReached && INTERNAL_RECOVERY_STATUSES.has(result.status)
      ? "budget_exceeded" as const
      : result.status;
    const finalResult: RunKyreiChatResult = {
      ...result,
      text,
      parts,
      status,
      attempts,
      ...(responseMessages.length ? { responseMessages } : {}),
      ...(usage ? { usage } : {}),
    };
    opts.emit({
      type: "message.complete",
      payload: {
        text,
        status,
        ...(usage ? { usage } : {}),
      },
    });
    return finalResult;
  }
}
