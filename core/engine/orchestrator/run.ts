/**
 * Orchestrator: the engine entry. Builds provider candidates + tools, runs the
 * AI SDK tool-calling loop via streamText (with no-tools + provider fallback
 * via openStream), bridges the normalized stream to our events, returns
 * { text, parts, status, attempts }.
 *
 * Deferred: prepareStep compaction (Phase 4).
 */

import { streamText, type ToolSet } from "ai";
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
import { buildSkillTools } from "../tools/skills.js";
import { buildDelegateTool } from "../orchestration/delegate.js";
import { createReadOnlyChildRunner, selectReadOnlyChildTools } from "../orchestration/read-child.js";
import {
  buildTeamDelegateTool,
  createTeamRoleExecutors,
} from "../team/index.js";
import { isWorkspaceDir } from "../security/jail.js";
import { createCcrStore, makeRetrieveTool } from "../context/ccr.js";
import { assembleSystemContext } from "../memory/layers.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildStopWhen } from "./stop-conditions.js";
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
    ...skillTools,
  };
  const tools = Object.keys(baseToolSet).length ? baseToolSet : undefined;
  const childTools = selectReadOnlyChildTools(
    workspaceTools,
    retrieveTools,
    webTools,
    brainTools,
    childSkillTools,
  );
  const delegationEnabled = cfg.delegation.enabled;
  const teamEnabled = Boolean(opts.team?.roles.length);
  const hasTools = Boolean(tools) || delegationEnabled || teamEnabled;

  let projectContext: string | undefined;
  if (workspaceReady) {
    try {
      const assembled = await assembleSystemContext({ workspace: opts.workspace! });
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
    personality: cfg.personality,
    promptProfile: cfg.promptProfiles.find((profile) => profile.id === cfg.activePromptProfileId)?.systemPrompt,
    projectContext,
    hasBrainTools: Object.keys(brainTools).length > 0,
    hasBrainWriteTools: cfg.memory.gbrain.mode === "read-write",
    hasDelegation: delegationEnabled,
    skills: opts.skills?.map(({ id, name, description }) => ({ id, name, description })),
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
    const providerOptions = buildProviderOptions(target.protocol, opts.modelParams);
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
    const prepareStep = ccr && contextWindow !== undefined
      ? makePrepareStep(cfg, entry.id, contextWindow, ccr)
      : undefined;
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
    const result = streamText({
      model,
      ...(instructions ? { instructions } : {}),
      messages: opts.messages,
      ...(callTools ? { tools: callTools, stopWhen: buildStopWhen(cfg) } : {}),
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
    return { stream: result.stream, responseMessages: result.responseMessages };
  };

  let stream: StreamLike;
  try {
    stream = attemptLifecycle
      ? await openStream(candidates.length, hasTools, start, { attemptLifecycle })
      : await openStream(candidates.length, hasTools, start);
  } catch (error) {
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
      approvalMeta,
    });
  } catch (error) {
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

  return {
    text: bridged.text,
    parts,
    status: bridged.status,
    ...(responseMessages?.length ? { responseMessages } : {}),
    attempts: publicAttempts(stream.attempts),
    route: {
      providerId: selected.target.providerId,
      modelId: selected.entry.id,
      ...(selected.target.accountId ? { accountId: selected.target.accountId } : {}),
    },
  };
}
