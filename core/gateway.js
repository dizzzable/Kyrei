import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, readFile, writeFile, mkdir, readdir, stat, rename, rm, realpath, open as openFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, relative } from "node:path";
import {
  SessionStore,
  SessionApprovalError,
  isSessionMessageId,
  sanitizeLegacyHealHandoffMessage,
} from "./session-store.js";
import {
  engineMessageToGateway,
  engineSessionToGateway,
  mergeSessionsPreferEngine,
  preferMessagesForPrimary,
} from "./session-engine-primary.js";
import {
  resolveApprovalInMessages,
  planRewindInMessages,
  commitRewindInMessages,
  SessionMutationError,
} from "./session-mutations.js";
import {
  normalizeMessagingConfig,
  publicMessagingStatus,
  generateMessagingToken,
} from "./messaging-config.js";
import {
  applyFileReviewDecisions,
  applyHunkDecisionsToFile,
  collectSessionFileChanges,
  withAggregatedReview,
  needsSelectiveHunkApply,
  applyHunksToOldText,
} from "./session-file-review.js";
import {
  beginSnapshotRestore,
  restoreSnapshotPaths,
  readSnapshotRelativeFile,
  writeWorkspaceRelativeFile,
  SessionCheckpointError,
} from "./session-checkpoints.js";
import {
  normalizePromptImages,
  persistPromptImages,
  imageAttachmentDisplayText,
  userContentFromStoredMessage,
  attachmentDirFor,
} from "./image-attachments.js";
import { permissionRuleFromApproval, mergePermissionRule } from "./permission-promote.js";
import { SkillsStore } from "./skills-store.js";
import {
  curateSkills,
  listSkillsCuratorProposals,
  applyStoredSkillsCuratorProposal,
  applySingleSkillsProposal,
  normalizeSkillsCuratorConfig,
} from "./skills-curator.js";
import {
  digestMessagesToTrajectory,
  normalizeSkillsSleepConfig,
  runSkillSleep,
} from "./skills-sleep.js";
import {
  listSkillPacks,
  enableSkillPack,
  disableSkillPack,
  BUILTIN_SKILL_PACKS,
} from "./skill-packs.js";
import { CronStore } from "./cron-store.js";
import { CronScheduler } from "./cron-scheduler.js";
import { TeamRunStore } from "./team-run-store.js";
import { PipelineRunStore } from "./pipeline-run-store.js";
import { PipelineMissionRunner } from "./pipeline-mission-runner.js";
import { WorkspaceLeaseStore } from "./workspace-lease-store.js";
import { observeWorkspace } from "./workspace-evidence.js";
import { redactSensitiveText, redactSensitiveValue } from "./secret-redaction.js";
import {
  MAX_TEAM_PROFILE_SKILLS,
  TeamConfigError,
  normalizeOrchestration,
  teamProfileSkillIds,
  validateOrchestrationInput,
} from "./team-config.js";
import {
  PipelineConfigError,
  normalizePipelines,
  validatePipelinesInput,
} from "./pipeline-config.js";
import { ProviderDiscoveryError, discoverProviderModels } from "./provider-discovery.js";
import { normalizeStoredModelCapabilities, resolveModelCapabilities } from "./model-capabilities.js";
import { publicProviderTemplates } from "./provider-templates.js";
import { ProviderAccountPoolRouter } from "./provider-account-pool.js";
import { KiroCliConnector } from "./kiro-cli-connector.js";
import { createKiroConnectorApi } from "./kiro-connector-api.js";
import {
  MAX_KIRO_ORGANIZATION_ACCOUNTS,
  KiroOrganizationConfigError,
  normalizeKiroOrganizationAccountSecret,
  normalizeKiroOrganizationConfig,
  normalizeKiroOrganizationSecrets,
  serializeKiroOrganizationSecrets,
} from "./kiro-organization-config.js";
import { KiroOrganizationBroker } from "./kiro-organization-broker.js";
import { KiroOrganizationWorker } from "./kiro-organization-worker.js";
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
  resolveBrowserSubscriptionCredentials,
  resolveProviderModel,
  selectProviderModel,
  setProviderAccountCredentials,
  upsertProvider,
  validateProviderAccountInput,
  validateProviderModelId,
  validateProviderPoolInput,
  validateProviderInput,
} from "./provider-config.js";
import { createUsageLedger } from "./usage-ledger.js";
import {
  budgetWindowStartMs,
  evaluateUsageBudget,
  normalizeUsageBudgetConfig,
  usageBudgetFromEngine,
} from "./usage-budget.js";
import {
  AccessTokenError,
  createAccessPrincipal,
  evaluatePrincipalBudget,
  extractAccessTokenFromRequest,
  normalizeAccessControl,
  normalizeAccessTokenHashes,
  patchPrincipal,
  publicAccessControl,
  regenerateAccessPrincipal,
  resolveAccessPrincipal,
} from "./access-tokens.js";
import {
  formatChatCompletionResponse,
  formatChatCompletionSseFrames,
  listCompatModels,
  newCompletionId,
  normalizeProxyConfig,
  openAiMessagesToModelMessages,
  parseChatCompletionRequest,
  resolveCompatModelRef,
} from "./openai-compat.js";
import {
  listFamilyModelRefs,
  normalizeCapacityConfig,
  orderCapacityCandidates,
} from "./capacity-router.js";

// A regular chat can expose many enabled skills, but a user-selected set is
// intentionally bounded so one accidental multi-select cannot spend an entire
// turn loading instructions before any useful work begins. Team profiles have
// their own larger, role-partitioned capacity in team-config.js.
const MAX_PROMPT_SKILLS = 32;
const PROMPT_SKILL_ID_RE = /^skill_[a-f0-9]{24}$/;

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
 *   POST /api/sessions/:id/rewind        -> restore edit checkpoints and truncate from one user message
 *   POST /api/sessions/:id/file-review   -> supervised accept/reject { accept } or { files:[{path,accept}] }
 *   GET  /api/sessions/:id/changes       -> list file mutations (view all changes)
 *   POST /api/sessions/:id/revert-all    -> restore all session snapshots
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
 *   GET  /api/messaging                  -> inbound webhook status (no secrets)
 *   POST /api/messaging/token            -> rotate webhook token
 *   POST /api/messaging/inbound          -> external ingress { text, sessionId? }
 *   GET  /api/usage?days=30              -> durable usage summary + budget status
 *   GET  /api/usage/events?limit=200     -> recent ledger events (accounting only)
 *   GET  /api/usage/budget               -> current soft/hard budget snapshot
 *   GET  /api/access-tokens              -> public principal list (no secrets)
 *   POST /api/access-tokens              -> create principal; returns plain token once
 *   PATCH /api/access-tokens/:id         -> enable/disable/label/budget
 *   DELETE /api/access-tokens/:id        -> revoke permanently
 *   POST /api/access-tokens/:id/regenerate -> new plain token once
 *   GET  /v1/models                      -> OpenAI-compatible catalog
 *   POST /v1/chat/completions            -> OpenAI-compatible chat (no tools)
 */

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Kyrei-Gateway-Token, Authorization, X-Kyrei-Messaging-Token, X-Kyrei-Access-Token",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(res.kyreiCors ?? {}) });
  res.end(JSON.stringify(body));
}

function internalModelMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(message => {
    if (!message || typeof message !== "object") return [];
    if ((message.role !== "assistant" && message.role !== "tool") || !Array.isArray(message.content)) return [];
    return [{ ...message, content: message.content.slice(0, 500) }];
  }).slice(0, 500);
}

function publicStoredMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    const sanitizedMessage = sanitizeLegacyHealHandoffMessage(message);
    const {
      modelMessages: _privateModelMessages,
      approvalModelParams: _privateApprovalModelParams,
      ...publicMessage
    } = sanitizedMessage ?? {};
    return publicMessage;
  });
}

function appendTurnStreamPart(parts, type, text) {
  if (typeof text !== "string" || !text) return parts;
  const next = [...parts];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const part = next[index];
    if (part?.type === type) {
      next[index] = { ...part, text: `${part.text ?? ""}${text}` };
      return next;
    }
    if (part?.type !== "text" && part?.type !== "reasoning") break;
  }
  next.push({ type, text });
  return next;
}

function turnToolIndex(parts, payload) {
  const toolCallId = typeof payload?.tool_call_id === "string" ? payload.tool_call_id : "";
  if (toolCallId) return parts.findIndex(part => part?.type === "tool" && part.toolCallId === toolCallId);
  const name = typeof payload?.name === "string" ? payload.name : "";
  if (!name) return -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "tool" && part.name === name && part.running === true) return index;
  }
  return -1;
}

function foldTurnDraftEvent(parts, event) {
  const payload = event?.payload ?? {};
  if (event?.type === "message.delta") return appendTurnStreamPart(parts, "text", payload.text);
  if (event?.type === "reasoning.delta") return appendTurnStreamPart(parts, "reasoning", payload.text);
  if (event?.type === "tool.start") {
    const index = turnToolIndex(parts, payload);
    const tool = {
      type: "tool",
      toolCallId: typeof payload.tool_call_id === "string" && payload.tool_call_id
        ? payload.tool_call_id
        : `tool-${parts.length}`,
      name: typeof payload.name === "string" && payload.name ? payload.name : "tool",
      args: payload.args,
      running: true,
    };
    if (index < 0) return [...parts, tool];
    const next = [...parts];
    next[index] = { ...next[index], ...tool };
    return next;
  }
  if (event?.type === "tool.progress") {
    const index = turnToolIndex(parts, payload);
    if (index < 0 || typeof payload.text !== "string" || !payload.text) return parts;
    const next = [...parts];
    next[index] = { ...next[index], progress: payload.text };
    return next;
  }
  if (event?.type === "tool.complete") {
    const index = turnToolIndex(parts, payload);
    const completed = {
      type: "tool",
      toolCallId: typeof payload.tool_call_id === "string" && payload.tool_call_id
        ? payload.tool_call_id
        : `tool-${parts.length}`,
      name: typeof payload.name === "string" && payload.name ? payload.name : "tool",
      running: false,
      ...(payload.result !== undefined ? { result: payload.result } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.duration_s !== undefined ? { durationS: payload.duration_s } : {}),
      ...(payload.inline_diff !== undefined ? { inlineDiff: payload.inline_diff } : {}),
      ...(payload.snapshot_id !== undefined ? { snapshotId: payload.snapshot_id } : {}),
    };
    if (index < 0) return [...parts, completed];
    const next = [...parts];
    next[index] = { ...next[index], ...completed, progress: undefined };
    return next;
  }
  if (event?.type === "approval.request") {
    const approvalId = typeof payload.approval_id === "string" ? payload.approval_id : "";
    const toolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : "";
    if (!approvalId || !toolCallId) return parts;
    const nextApproval = {
      type: "approval",
      approvalId,
      toolCallId,
      name: typeof payload.name === "string" && payload.name ? payload.name : "tool",
      ...(payload.args !== undefined ? { args: payload.args } : {}),
      ...(typeof payload.reason === "string" && payload.reason ? { reason: payload.reason } : {}),
      status: "pending",
    };
    const index = parts.findIndex(part => part?.type === "approval" && part.approvalId === approvalId);
    if (index < 0) return [...parts, nextApproval];
    const next = [...parts];
    next[index] = { ...next[index], ...nextApproval };
    return next;
  }
  if (event?.type === "error" && typeof payload.message === "string" && payload.message.trim()) {
    return appendTurnStreamPart(parts, "text", payload.message.trim());
  }
  return parts;
}

function interruptedTurnParts(parts) {
  return parts.map(part => part?.type === "tool" && part.running === true
    ? {
        ...part,
        running: false,
        error: typeof part.error === "string" && part.error ? part.error : "tool_interrupted",
        progress: undefined,
      }
    : part);
}

function textFromTurnParts(parts) {
  return parts
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("");
}

function meaningfulTurnParts(parts) {
  return parts.some(part => {
    if (part?.type === "text" || part?.type === "reasoning") return typeof part.text === "string" && part.text.length > 0;
    return part?.type === "tool" || part?.type === "approval";
  });
}

/**
 * SSE is the canonical execution trace; a provider's terminal aggregate can
 * be abbreviated (often text-only). Merge its additional structured details
 * without dropping streamed reasoning, tool activity, diffs, or approvals.
 */
function mergeTerminalTurnParts(streamed, terminal) {
  if (!Array.isArray(streamed) || streamed.length === 0) return Array.isArray(terminal) ? terminal : [];
  if (!Array.isArray(terminal) || terminal.length === 0) return streamed;
  const next = [...streamed];
  for (const finalPart of terminal) {
    if (!finalPart || typeof finalPart !== "object") continue;
    const index = finalPart.type === "tool"
      ? next.findIndex(part => part?.type === "tool" && part.toolCallId === finalPart.toolCallId)
      : finalPart.type === "approval"
        ? next.findIndex(part => part?.type === "approval" && part.approvalId === finalPart.approvalId)
        : -1;
    if (index >= 0) {
      next[index] = { ...next[index], ...finalPart, progress: undefined };
      continue;
    }
    // Do not duplicate a streamed text/reasoning segment with the same
    // aggregate content. If no stream exists for that channel, retain it.
    if ((finalPart.type === "text" || finalPart.type === "reasoning")
      && next.some(part => part?.type === finalPart.type)) continue;
    next.push(finalPart);
  }
  return next;
}

function normalizedModelParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const next = {};
  if (typeof value.effort === "string" && value.effort.length <= 32) next.effort = value.effort;
  if (typeof value.fast === "boolean") next.fast = value.fast;
  if (typeof value.reasoning === "boolean") next.reasoning = value.reasoning;
  if (typeof value.contextWindowOverride === "number" && Number.isFinite(value.contextWindowOverride)) {
    next.contextWindowOverride = value.contextWindowOverride;
  }
  if (typeof value.maxOutputOverride === "number" && Number.isFinite(value.maxOutputOverride)) {
    next.maxOutputOverride = value.maxOutputOverride;
  }
  return Object.keys(next).length ? next : undefined;
}

function approvalResponses(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap(part => {
    if (part?.type !== "approval" || part.status === "pending") return [];
    const approved = part.status === "approved";
    return [{
      type: "tool-approval-response",
      approvalId: part.approvalId,
      approved,
      reason: part.decisionReason || (part.status === "expired" ? "approval_expired" : approved ? "user_approved_once" : "user_denied"),
    }];
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const signal = req?.kyreiShutdownSignal;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      req.removeListener("aborted", onRequestAborted);
      req.removeListener("error", onRequestError);
      signal?.removeEventListener?.("abort", onGatewayShutdown);
      callback(value);
    };
    const shutdownError = () => {
      const error = new Error("gateway_shutdown");
      error.code = "gateway_shutdown";
      return error;
    };
    const onGatewayShutdown = () => finish(reject, shutdownError());
    const onRequestAborted = () => finish(reject, shutdownError());
    const onRequestError = (error) => finish(reject, error);
    if (signal?.aborted) {
      onGatewayShutdown();
      return;
    }
    signal?.addEventListener?.("abort", onGatewayShutdown, { once: true });
    req.on("data", chunk => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > 20_000_000) {
        const error = new Error("request_body_too_large");
        error.code = "request_body_too_large";
        finish(reject, error);
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks, size).toString("utf8");
        finish(resolve, raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error("invalid_json");
        error.code = "invalid_json";
        finish(reject, error);
      }
    });
    req.once("aborted", onRequestAborted);
    req.once("error", onRequestError);
  });
}

function kiroOrganizationError(code) {
  return new KiroOrganizationConfigError(code, code);
}

function strictRequestRecord(value, code = "kiro_organization_request_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw kiroOrganizationError(code);
  }
  return value;
}

function assertOnlyFields(value, fields, code = "kiro_organization_request_field_invalid") {
  const source = strictRequestRecord(value);
  for (const key of Object.keys(source)) {
    if (!fields.has(key)) throw kiroOrganizationError(code);
  }
  return source;
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

function pruneKiroOrganizationSecrets(secretState, organizationConfig) {
  const next = normalizeProviderSecrets(secretState);
  const allowedIds = new Set(
    (Array.isArray(organizationConfig?.accounts) ? organizationConfig.accounts : [])
      .map((account) => account?.id)
      .filter((accountId) => typeof accountId === "string"),
  );
  const retained = new Map(
    [...normalizeKiroOrganizationSecrets(next.kiroOrganization)]
      .filter(([accountId]) => allowedIds.has(accountId)),
  );
  next.kiroOrganization = serializeKiroOrganizationSecrets(retained);
  return next;
}

function sameModelEndpoint(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function privateRuntimeModelLimits(model) {
  const source = model?.capabilities?.limits;
  const contextWindow = Number.isSafeInteger(source?.contextWindow)
    && source.contextWindow >= 256
    && source.contextWindow <= 100_000_000
    ? source.contextWindow
    : undefined;
  const maxOutput = Number.isSafeInteger(source?.maxOutput)
    && source.maxOutput >= 1
    && source.maxOutput <= 10_000_000
    ? source.maxOutput
    : undefined;
  return contextWindow !== undefined || maxOutput !== undefined
    ? {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
      }
    : undefined;
}

function providerIsReady(provider, secretState, configState) {
  return Boolean(provider?.enabled && hasReadyProviderCredentials(provider, secretState, configState));
}

/**
 * Resolve a provider/model that is credential-ready.
 * With fallbackToDefault: fall back to the active default only when the
 * requested target is missing/disabled or has no credentials (first-run:
 * session still bound to the unready default stub). Do NOT fall back on
 * account-eligibility failures — those are intentional model bindings.
 */
function requireReadyProviderModel(configState, secretState, providerId, modelId, options = {}) {
  const errorCode = (error) => (
    typeof error?.code === "string" ? error.code
      : typeof error?.message === "string" ? error.message
        : ""
  );
  const mayFallbackToDefault = (error) => {
    const code = errorCode(error);
    return code === "provider_unavailable"
      || code === "provider_model_unavailable"
      || code === "provider_credentials_required";
  };
  const tryReady = (pid, mid, resolveOptions = {}) => {
    const target = resolveProviderModel(configState, pid, mid, resolveOptions);
    if (!providerIsReady(target.provider, secretState, configState)) {
      throw new ProviderConfigError("provider_credentials_required");
    }
    const hasEligibleAccount = readyProviderAccounts(target.provider, secretState, configState).some((account) => (
      !Object.hasOwn(account, "modelIds") || account.modelIds.includes(target.model.id)
    ));
    if (!hasEligibleAccount) throw new ProviderConfigError("provider_accounts_unavailable");
    return target;
  };

  try {
    return tryReady(providerId, modelId);
  } catch (primaryError) {
    if (!options.fallbackToDefault || !mayFallbackToDefault(primaryError)) throw primaryError;
    try {
      return tryReady(configState.activeProviderId, configState.activeModelId);
    } catch {
      // Active may itself be the same unready stub — last chance: resolve with
      // identity fallback when the session ids are simply missing/disabled.
      try {
        return tryReady(providerId, modelId, { fallbackToDefault: true });
      } catch {
        throw primaryError;
      }
    }
  }
}

function isActiveProviderReady(configState, secretState) {
  try {
    requireReadyProviderModel(
      configState,
      secretState,
      configState.activeProviderId,
      configState.activeModelId,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * First-run / heal path: activate this provider when the caller asked for it,
 * or when the current active default is still unready and this candidate is ready.
 */
function shouldActivateProviderAsDefault(configState, secretState, providerId, modelId, body = {}) {
  if (body.useAsDefault === true || body.activate === true) return true;
  if (isActiveProviderReady(configState, secretState)) return false;
  try {
    requireReadyProviderModel(configState, secretState, providerId, modelId);
    return true;
  } catch {
    return false;
  }
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
  const build = requestedAssignments.build == null
    ? undefined
    : resolveAssignment(requestedAssignments.build);
  const polish = requestedAssignments.polish == null
    ? undefined
    : resolveAssignment(requestedAssignments.polish);
  const plan = requestedAssignments.plan == null
    ? undefined
    : resolveAssignment(requestedAssignments.plan);
  const deepreep = requestedAssignments.deepreep == null
    ? undefined
    : resolveAssignment(requestedAssignments.deepreep);
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
    modelAssignments: {
      ...(worker ? { worker } : {}),
      ...(build ? { build } : {}),
      ...(polish ? { polish } : {}),
      ...(plan ? { plan } : {}),
      ...(deepreep ? { deepreep } : {}),
      fallbacks,
    },
  });
}

function reconcileReadyModelAssignments(configState, secretState) {
  const readyRole = (assignment) => {
    if (!assignment) return undefined;
    try {
      requireReadyProviderModel(configState, secretState, assignment.providerId, assignment.modelId);
      return assignment;
    } catch {
      return undefined;
    }
  };
  const worker = configState.modelAssignments?.worker;
  const build = configState.modelAssignments?.build;
  const polish = configState.modelAssignments?.polish;
  const plan = configState.modelAssignments?.plan;
  const deepreep = configState.modelAssignments?.deepreep;
  const readyWorker = readyRole(worker);
  const readyBuild = readyRole(build);
  const readyPolish = readyRole(polish);
  const readyPlan = readyRole(plan);
  const readyDeepreep = readyRole(deepreep);
  const readyFallbacks = (configState.modelAssignments?.fallbacks ?? []).filter((fallback) => {
    try {
      requireReadyProviderModel(configState, secretState, fallback.providerId, fallback.modelId);
      return true;
    } catch {
      return false;
    }
  });
  const unchanged = readyWorker === worker
    && readyBuild === build
    && readyPolish === polish
    && readyPlan === plan
    && readyDeepreep === deepreep
    && readyFallbacks.length === (configState.modelAssignments?.fallbacks ?? []).length;
  if (unchanged) return configState;
  return normalizeGatewayConfig({
    ...configState,
    modelAssignments: {
      ...(readyWorker ? { worker: readyWorker } : {}),
      ...(readyBuild ? { build: readyBuild } : {}),
      ...(readyPolish ? { polish: readyPolish } : {}),
      ...(readyPlan ? { plan: readyPlan } : {}),
      ...(readyDeepreep ? { deepreep: readyDeepreep } : {}),
      fallbacks: readyFallbacks,
    },
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
  if (code === "gateway_shutdown") return 503;
  if (
    code === "gbrain_command_unavailable"
    || code === "gbrain_adapter_unavailable"
    || code === "gbrain_bun_unavailable"
  ) return 503;
  if (code === "gbrain_initialization_unavailable") return 409;
  if (
    code === "gbrain_initialization_failed"
    || code === "gbrain_initialization_unverified"
    || code === "gbrain_install_failed"
    || code === "gbrain_install_unverified"
    || code === "gbrain_global_bin_invalid"
  ) return 502;
  if (code === "approval_decision_invalid") return 400;
  if (code === "secret_storage_unavailable") return 503;
  if (code === "provider_discovery_unauthorized") return 401;
  if (code === "provider_discovery_target_blocked") return 403;
  if (code === "provider_discovery_rate_limited") return 429;
  if (code === "provider_discovery_timeout") return 504;
  if (code === "provider_discovery_unavailable" || code === "provider_discovery_invalid_response" || code === "provider_discovery_response_too_large") return 502;
  if (code === "kiro_organization_protected_storage_required") return 503;
  if (code === "kiro_organization_credential_required" || code === "kiro_organization_verification_required") return 409;
  if (code === "kiro_organization_verification_failed") return 401;
  if (code === "kiro_organization_cli_timeout") return 504;
  if (code === "kiro_organization_cli_not_found" || code === "kiro_organization_cli_version_unsupported" || code === "kiro_organization_cli_termination_unconfirmed" || code === "kiro_organization_broker_closed") return 503;
  if (
    code === "kiro_organization_cli_start_failed"
    || code === "kiro_organization_cli_command_failed"
    || code === "kiro_organization_cli_output_limit"
    || code === "kiro_organization_cli_output_invalid"
    || code === "kiro_organization_cli_version_invalid"
    || code === "kiro_organization_whoami_invalid"
    || code === "kiro_organization_credential_reflected"
    || code.startsWith("kiro_organization_model_")
    || code.startsWith("kiro_organization_models_")
  ) return 502;
  if (code === "kiro_organization_operation_stale" || code === "kiro_organization_reconfigured" || code === "kiro_organization_lease_stale") return 409;
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
    || code === "approval_required"
    || code === "approval_already_consumed"
    || code === "approval_decision_conflict"
    || code === "approval_expired"
    || code === "approval_not_resolved"
  ) return 409;
  if (
    code.startsWith("pipeline_")
    || code.startsWith("workspace_lease_")
  ) return 400;
  if (error?.name === "SkillsStoreError" || error?.name === "ProviderConfigError" || error?.name === "ProviderDiscoveryError" || error?.name === "TeamConfigError" || error?.name === "PipelineConfigError" || error?.name === "KiroOrganizationConfigError" || error?.name === "KiroOrganizationBrokerError" || error?.name === "KiroOrganizationWorkerError" || error?.name === "BrowserSubscriptionAuthError" || error instanceof TypeError || error instanceof RangeError) return 400;
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

/** A public, non-sensitive error used by the optional local GBrain control plane. */
function gbrainGatewayError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The gateway owns the persistent configuration, while the engine owns the
 * actual GBrain process adapter. Keep this small normalizer here so a stale
 * or hand-edited public config cannot turn the setup/status endpoint into an
 * arbitrary process launcher.
 */
function configuredGBrainRuntime(engineConfig) {
  const memory = isPlainRecord(engineConfig?.memory) ? engineConfig.memory : {};
  const raw = isPlainRecord(memory.gbrain) ? memory.gbrain : {};
  // Keep legacy custom commands external even before the engine config is
  // next saved/migrated. The old implicit `gbrain` default becomes built-in.
  const legacyCommand = typeof raw.command === "string" ? raw.command.trim() : "";
  const provider = raw.provider === "external-cli"
    || (raw.provider == null && legacyCommand && legacyCommand !== "gbrain")
    ? "external-cli"
    : "builtin";
  const mode = raw.mode === "read" || raw.mode === "read-write" ? raw.mode : "off";
  const command = provider === "external-cli" && typeof raw.command === "string" && raw.command.trim() && raw.command.trim().length <= 1_024
    ? raw.command.trim()
    : "gbrain";
  const source = typeof raw.source === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(raw.source.trim())
    ? raw.source.trim()
    : undefined;
  const timeoutMs = Number.isSafeInteger(raw.timeoutMs) && raw.timeoutMs >= 1_000 && raw.timeoutMs <= 3_600_000
    ? raw.timeoutMs
    : 180_000;
  const maxOutputBytes = Number.isSafeInteger(raw.maxOutputBytes) && raw.maxOutputBytes >= 1_000 && raw.maxOutputBytes <= 5_000_000
    ? raw.maxOutputBytes
    : 200_000;
  return { provider, mode, ...(provider === "external-cli" ? { command } : {}), ...(source ? { source } : {}), timeoutMs, maxOutputBytes };
}

function gbrainDoctorState(doctor) {
  if (!isPlainRecord(doctor)) return { state: "error", doctorStatus: "unknown" };
  const status = ["ok", "warnings", "error"].includes(doctor.status)
    ? doctor.status
    : "unknown";
  // The CLI intentionally has no stable "initialized" boolean. Its documented
  // diagnostics do, however, tell us when no local database/config exists. Do
  // not surface the raw report here: it is untrusted local data and can include
  // environment-specific paths. The UI only needs a truthful, compact state.
  let summary = "";
  try { summary = JSON.stringify(doctor).slice(0, 20_000); } catch { /* malformed result is handled below */ }
  if (/\b(?:not initialized|no database configured|database (?:is )?(?:missing|not configured)|run\s+gbrain\s+init|Kyrei Memory local store is not initialized)\b/i.test(summary)) {
    return { state: "not_initialized", doctorStatus: status };
  }
  if (status === "error" || !summary) return { state: "error", doctorStatus: status };
  return { state: "ready", doctorStatus: status };
}

function gbrainFailureState(error) {
  const message = String(error?.message ?? error ?? "");
  if (/\b(?:could not start|enoent|not found|spawn)\b/i.test(message)) {
    return { state: "unavailable", reason: "command_unavailable" };
  }
  if (/\b(?:not initialized|no database|database (?:is )?(?:missing|not configured)|run\s+gbrain\s+init|Kyrei Memory local store is not initialized)\b/i.test(message)) {
    return { state: "not_initialized", reason: "not_initialized" };
  }
  return { state: "error", reason: "check_failed" };
}

function validateEnginePermissionRulesBoundary(value) {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError("engine_permission_rules_invalid");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("engine_permission_rules_invalid");
    }
    const pattern = entry.pattern;
    const action = entry.action;
    if (
      typeof pattern !== "string"
      || pattern.length < 1
      || pattern.length > 512
      || /[\u0000-\u001f\u007f]/.test(pattern)
      || (action !== "allow" && action !== "ask" && action !== "deny")
    ) {
      throw new TypeError("engine_permission_rules_invalid");
    }
    try {
      new RegExp(pattern);
    } catch {
      throw new TypeError("engine_permission_rules_invalid");
    }
    return { pattern, action };
  });
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
  const next = { ...value };
  if (
    value.permissions
    && typeof value.permissions === "object"
    && !Array.isArray(value.permissions)
    && Object.hasOwn(value.permissions, "rules")
  ) {
    next.permissions = {
      ...value.permissions,
      rules: validateEnginePermissionRulesBoundary(value.permissions.rules),
    };
  }
  const profileIds = new Set();
  if (Object.hasOwn(value, "promptProfiles")) {
    if (!Array.isArray(value.promptProfiles) || value.promptProfiles.length > 64) {
      throw new TypeError("engine_prompt_profiles_invalid");
    }
    next.promptProfiles = value.promptProfiles.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("engine_prompt_profile_invalid");
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const description = entry.description === undefined
        ? ""
        : typeof entry.description === "string"
          ? entry.description.trim()
          : null;
      const systemPrompt = typeof entry.systemPrompt === "string" ? entry.systemPrompt.trim() : null;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || profileIds.has(id)) {
        throw new TypeError("engine_prompt_profile_id_invalid");
      }
      if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new TypeError("engine_prompt_profile_name_invalid");
      }
      if (description === null || description.length > 1_000 || /[\u0000-\u001f\u007f]/.test(description)) {
        throw new TypeError("engine_prompt_profile_description_invalid");
      }
      if (
        systemPrompt === null
        || systemPrompt.length > 20_000
        || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(systemPrompt)
      ) throw new TypeError("engine_prompt_profile_system_prompt_invalid");
      profileIds.add(id);
      return { id, name, description, systemPrompt };
    });
  } else {
    for (const profile of Array.isArray(value.promptProfiles) ? value.promptProfiles : []) profileIds.add(profile.id);
  }
  if (Object.hasOwn(value, "activePromptProfileId")) {
    const activeId = typeof value.activePromptProfileId === "string" ? value.activePromptProfileId.trim() : null;
    if (
      activeId === null
      || (activeId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(activeId))
      || (activeId && !profileIds.has(activeId))
    ) throw new TypeError("engine_active_prompt_profile_invalid");
    next.activePromptProfileId = activeId;
  }
  // Lightweight memory.index boundary: keep invalid backends from reaching the engine.
  if (Object.hasOwn(value, "memory") && value.memory && typeof value.memory === "object" && !Array.isArray(value.memory)) {
    const memory = { ...value.memory };
    if (Object.hasOwn(memory, "gbrain") && memory.gbrain && typeof memory.gbrain === "object" && !Array.isArray(memory.gbrain)) {
      const gbrain = { ...memory.gbrain };
      if (Object.hasOwn(gbrain, "provider") && !new Set(["builtin", "external-cli"]).has(gbrain.provider)) {
        throw new TypeError("engine_memory_gbrain_provider_invalid");
      }
      if (Object.hasOwn(gbrain, "mode") && !new Set(["off", "read", "read-write"]).has(gbrain.mode)) {
        throw new TypeError("engine_memory_gbrain_mode_invalid");
      }
      if (Object.hasOwn(gbrain, "command") && (
        typeof gbrain.command !== "string"
        || !gbrain.command.trim()
        || gbrain.command.length > 1_024
        || gbrain.command.includes("\0")
      )) {
        throw new TypeError("engine_memory_gbrain_command_invalid");
      }
      if (Object.hasOwn(gbrain, "source") && gbrain.source != null && (
        typeof gbrain.source !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(gbrain.source.trim())
      )) {
        throw new TypeError("engine_memory_gbrain_source_invalid");
      }
      memory.gbrain = gbrain;
    }
    if (Object.hasOwn(memory, "index") && memory.index && typeof memory.index === "object" && !Array.isArray(memory.index)) {
      const index = { ...memory.index };
      if (Object.hasOwn(index, "enabled") && typeof index.enabled !== "boolean") {
        throw new TypeError("engine_memory_index_enabled_invalid");
      }
      if (Object.hasOwn(index, "backend")) {
        if (!new Set(["sqlite", "postgres", "off"]).has(index.backend)) {
          throw new TypeError("engine_memory_index_backend_invalid");
        }
      }
      if (Object.hasOwn(index, "connectionString")) {
        if (typeof index.connectionString !== "string" || index.connectionString.length > 4_000) {
          throw new TypeError("engine_memory_index_connection_invalid");
        }
      }
      if (Object.hasOwn(index, "connectionSource") && !new Set(["builtin", "external"]).has(index.connectionSource)) {
        throw new TypeError("engine_memory_index_connection_source_invalid");
      }
      memory.index = index;
    }
    if (Object.hasOwn(memory, "ltm") && memory.ltm && typeof memory.ltm === "object" && !Array.isArray(memory.ltm)) {
      if (Object.hasOwn(memory.ltm, "enabled") && typeof memory.ltm.enabled !== "boolean") {
        throw new TypeError("engine_memory_ltm_enabled_invalid");
      }
    }
    if (Object.hasOwn(memory, "openviking") && memory.openviking && typeof memory.openviking === "object" && !Array.isArray(memory.openviking)) {
      if (Object.hasOwn(memory.openviking, "enabled") && typeof memory.openviking.enabled !== "boolean") {
        throw new TypeError("engine_memory_openviking_enabled_invalid");
      }
      if (Object.hasOwn(memory.openviking, "baseURL") && memory.openviking.baseURL != null) {
        if (typeof memory.openviking.baseURL !== "string" || memory.openviking.baseURL.length > 2_048) {
          throw new TypeError("engine_memory_openviking_url_invalid");
        }
      }
    }
    next.memory = memory;
  }
  if (Object.hasOwn(value, "planning") && value.planning && typeof value.planning === "object" && !Array.isArray(value.planning)) {
    if (Object.hasOwn(value.planning, "enabled") && typeof value.planning.enabled !== "boolean") {
      throw new TypeError("engine_planning_enabled_invalid");
    }
  }
  return next;
}

function promptProfileIdsForEngine(engine) {
  return new Set(
    (Array.isArray(engine?.promptProfiles) ? engine.promptProfiles : [])
      .map((profile) => typeof profile?.id === "string" ? profile.id : "")
      .filter(Boolean),
  );
}

function validatePromptProfileAssignments(engine, orchestration) {
  const ids = promptProfileIdsForEngine(engine);
  if (engine?.activePromptProfileId && !ids.has(engine.activePromptProfileId)) {
    throw new TypeError("engine_active_prompt_profile_invalid");
  }
  for (const profile of orchestration?.profiles ?? []) {
    for (const role of profile.roles ?? []) {
      if (role.promptProfileId && !ids.has(role.promptProfileId)) {
        throw new TeamConfigError("team_role_prompt_profile_unavailable");
      }
    }
  }
  return ids;
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
  // applied is allowed only with a deterministic postcondition: current workspace
  // digest matches the marker AND the workspace actually changed vs stage baseline.
  // Free-form human claims without matching observation remain rejected.
  if (marker.outcome === "applied") {
    const baseline = stage.workspaceDigestBefore;
    if (
      typeof baseline !== "string"
      || !/^[a-f0-9]{64}$/i.test(baseline)
      || observation.digest.toLowerCase() === baseline.toLowerCase()
    ) {
      throw pipelineConflict("pipeline_write_outcome_unverifiable");
    }
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
  const secretMutationFencePath = join(dataDir, ".kyrei-secret-mutation-fence.json");
  let writeTail = Promise.resolve();
  let revisionSequence = 0;
  let committedSecretsFingerprint = "";
  let committedSecretsKnown = false;
  let secretMutationFenceActive = false;
  const hasSecretMaterial = (value) => {
    const normalized = normalizeProviderSecrets(value);
    return Object.keys(normalized.providers).length > 0
      || Object.keys(normalized.accounts).length > 0
      || normalizeKiroOrganizationSecrets(normalized.kiroOrganization).size > 0;
  };
  const secretStateFingerprint = (value) => createHash("sha256")
    .update(canonicalJson(normalizeProviderSecrets(value)), "utf8")
    .digest("hex");
  const rememberLoadedPair = (pair) => {
    committedSecretsFingerprint = secretStateFingerprint(pair.secrets);
    committedSecretsKnown = true;
    return pair;
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
        const isFenceTemp = directory === dataDir && /^\.\.kyrei-secret-mutation-fence\.json\..+\.tmp$/.test(name);
        const isSnapshotTemp = directory === snapshotDir && /^\.(?:config|secrets)-[a-z0-9-]+\.json\..+\.tmp$/.test(name);
        if (isMainTemp || isFenceTemp || isSnapshotTemp) await fs.rm(join(directory, name), { force: true }).catch(() => {});
      }
    }
  };

  const secretMutationFenceExists = async () => {
    try {
      await fs.readFile(secretMutationFencePath, "utf8");
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      // An unreadable or malformed fence is still a fence. Loading any prior
      // credential generation would be less safe than failing closed.
      return true;
    }
  };

  const publicConfigFallback = async () => {
    try {
      return JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {
      return {};
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
    secretMutationFenceActive = await secretMutationFenceExists();
    if (secretMutationFenceActive) {
      // A credential mutation did not reach its durable completion point. The
      // public config remains recoverable, but no main/snapshot credential is
      // trusted until an empty/sanitized pair is committed and clears the fence.
      await purgeSnapshots({ strict: true });
      return rememberLoadedPair({ config: await publicConfigFallback(), secrets: {} });
    }
    try {
      return rememberLoadedPair(await loadPair(configPath, secretsPath));
    } catch (error) {
      // A readable encrypted envelope proves that this store is protected.
      // Never fall back to an older plaintext generation when safeStorage is
      // unavailable, because that would silently downgrade secret protection.
      if (error instanceof SecretStorageUnavailableError) throw error;
    }
    const pairs = await snapshotPairs();
    for (const pair of pairs) {
      try {
        return rememberLoadedPair(await loadPair(pair.configFile, pair.secretsFile, pair.revision));
      } catch (error) {
        if (error instanceof SecretStorageUnavailableError) throw error;
      }
    }

    // No consistent pair exists (first run or unrecoverable corruption). Keep a
    // valid public config when possible, but never combine it with unverified
    // credentials from another revision.
    return rememberLoadedPair({ config: await publicConfigFallback(), secrets: {} });
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

  const purgeSnapshots = async ({ strict = false } = {}) => {
    let names = [];
    try { names = await fs.readdir(snapshotDir); } catch { return; }
    await Promise.all(names.map(async name => {
      if (!/^(?:config|secrets)-[a-z0-9-]+\.json$/.test(name)) return Promise.resolve();
      if (strict) return fs.rm(join(snapshotDir, name), { force: true });
      return fs.rm(join(snapshotDir, name), { force: true }).catch(() => {});
    }));
    if (!strict) return;
    const remaining = (await fs.readdir(snapshotDir))
      .filter(name => /^(?:config|secrets)-[a-z0-9-]+\.json$/.test(name));
    if (remaining.length) throw new Error("provider-persistence-recovery-fence-failed");
    if (process.platform !== "win32") {
      const directoryHandle = await fs.open(snapshotDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  };

  const writeSecretMutationFence = async (revision) => {
    await atomicWrite(secretMutationFencePath, JSON.stringify({
      version: 1,
      revision,
      state: "pending-secret-mutation",
    }, null, 2), { secret: true });
    secretMutationFenceActive = true;
  };

  const clearSecretMutationFence = async () => {
    await fs.rm(secretMutationFencePath, { force: true });
    if (await secretMutationFenceExists()) {
      throw new Error("provider-persistence-secret-fence-clear-failed");
    }
    if (process.platform !== "win32") {
      const directoryHandle = await fs.open(dataDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
    secretMutationFenceActive = false;
  };

  const commit = async ({ revision, configSnapshot, secretsSnapshot }) => {
    await fs.mkdir(snapshotDir, { recursive: true });
    if (!committedSecretsKnown) await load();
    const configStored = JSON.stringify(persistedValue(configSnapshot, revision), null, 2);
    const nextSecretsFingerprint = secretStateFingerprint(secretsSnapshot);

    // A prior recovery pair may contain a key that this transaction removes or
    // rotates. Invalidate it durably before the secrets commit point. If the
    // following config rename fails, load() must prefer fail-closed credential
    // loss over resurrecting any earlier credential generation.
    if (nextSecretsFingerprint !== committedSecretsFingerprint && !secretMutationFenceActive) {
      await writeSecretMutationFence(revision);
    }
    if (secretMutationFenceActive) {
      await purgeSnapshots({ strict: true });
    }
    const secretsStored = await encodeSecrets(secretsSnapshot, revision);

    // Main state is the commit point. A crash between these two renames leaves
    // different revisions. Recovery is available for metadata-only writes;
    // credential mutations deliberately removed the older recovery pair above.
    await atomicWrite(secretsPath, secretsStored, { secret: true });
    await atomicWrite(configPath, configStored);
    committedSecretsFingerprint = nextSecretsFingerprint;
    committedSecretsKnown = true;

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
      await purgeSnapshots({ strict: secretMutationFenceActive });
    }
    if (secretMutationFenceActive) await clearSecretMutationFence();
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
    secretMutationFencePath,
    load,
    save,
    drain: () => writeTail,
  };
}

/**
 * Keep the in-memory Skills workspace aligned with the durable gateway config.
 * Skills validates the workspace before the config write; if that write fails,
 * restore its previous root before surfacing the error to the caller.
 */
export async function saveConfigWithWorkspace({
  previousWorkspace = "",
  nextWorkspace = "",
  skillsStore,
  saveConfig,
}) {
  await skillsStore.setWorkspace(nextWorkspace);
  try {
    return await saveConfig();
  } catch (error) {
    try {
      await skillsStore.setWorkspace(previousWorkspace);
    } catch {
      /* The original durable-save error is the actionable failure. */
    }
    throw error;
  }
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
  kiroOrganizationWorker,
  commandRunner,
  localPostgres,
  engineLoader = () => import("./engine/.dist/index.mjs"),
  providerDiscovery = discoverProviderModels,
  sandboxCapabilityProbe = pipelineSandboxCapability,
  runtimeBuildId = process.env.KYREI_BUILD_ID ?? process.env.npm_package_version ?? "development",
  activeTurnSettleTimeoutMs = 2_000,
} = {}) {
  if (typeof engineLoader !== "function") throw new TypeError("engine-loader-required");
  if (commandRunner != null && typeof commandRunner.run !== "function") {
    throw new TypeError("command-runner-invalid");
  }
  if (localPostgres != null && (
    typeof localPostgres.ensure !== "function"
    || typeof localPostgres.getStatus !== "function"
    || typeof localPostgres.close !== "function"
  )) {
    throw new TypeError("local-postgres-runtime-invalid");
  }
  if (typeof providerDiscovery !== "function") throw new TypeError("provider-discovery-required");
  if (typeof sandboxCapabilityProbe !== "function") throw new TypeError("sandbox-capability-probe-required");
  const turnSettleTimeoutMs = Number.isFinite(activeTurnSettleTimeoutMs)
    ? Math.min(30_000, Math.max(10, Math.floor(activeTurnSettleTimeoutMs)))
    : 2_000;
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
  const capabilityReceipts = new Map();
  const capabilityReceiptTtlMs = 10 * 60_000;
  const capabilityReceiptKey = ({ protocol, baseURL, modelId }) => {
    try {
      const url = new URL(String(baseURL ?? ""));
      if (url.username || url.password || url.search || url.hash) return "";
      const canonicalBaseURL = url.href.replace(/\/+$/, "");
      return `${String(protocol ?? "")}\0${canonicalBaseURL}\0${String(modelId ?? "")}`;
    } catch {
      return "";
    }
  };
  const capabilityDigest = (value) => {
    const normalized = normalizeStoredModelCapabilities(value);
    return normalized ? digestJson(normalized) : "";
  };
  const pruneCapabilityReceipts = () => {
    const now = Date.now();
    for (const [key, receipt] of capabilityReceipts) {
      if (receipt.expiresAt <= now) capabilityReceipts.delete(key);
    }
    while (capabilityReceipts.size > 4_096) {
      capabilityReceipts.delete(capabilityReceipts.keys().next().value);
    }
  };
  const rememberDiscoveredCapabilities = ({ protocol, baseURL, models }) => {
    pruneCapabilityReceipts();
    const expiresAt = Date.now() + capabilityReceiptTtlMs;
    for (const model of Array.isArray(models) ? models : []) {
      const key = capabilityReceiptKey({ protocol, baseURL, modelId: model?.id });
      const digest = capabilityDigest(model?.capabilities);
      if (key && digest) capabilityReceipts.set(key, { digest, expiresAt });
    }
  };
  const liveCapabilityVerifier = (existingProvider) => ({ capabilities, protocol, baseURL, modelId }) => {
    const key = capabilityReceiptKey({ protocol, baseURL, modelId });
    const digest = capabilityDigest(capabilities);
    if (!key || !digest) return false;
    pruneCapabilityReceipts();
    const recent = capabilityReceipts.get(key);
    if (recent?.digest === digest) return true;
    if (
      existingProvider?.protocol !== protocol
      || existingProvider?.baseURL !== baseURL
    ) return false;
    const existingModel = existingProvider.models?.find((model) => model.id === modelId);
    return capabilityDigest(existingModel?.capabilities) === digest;
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
  let secrets = pruneKiroOrganizationSecrets(
    pruneProviderAccountSecrets(normalizeProviderSecrets(loaded.secrets), config.providers),
    config.kiroOrganization,
  );
  if (!secrets.approvalSigningKey) {
    secrets = normalizeProviderSecrets({
      ...secrets,
      approvalSigningKey: randomBytes(32).toString("base64url"),
    });
  }
  const legacyApiKey = typeof rawConfig.apiKey === "string" ? rawConfig.apiKey : "";
  if (legacyApiKey && !secrets.providers[config.activeProviderId]?.apiKey) {
    secrets.providers[config.activeProviderId] = {
      ...(secrets.providers[config.activeProviderId] ?? {}),
      apiKey: legacyApiKey,
    };
  }
  config = reconcileReadyRuntimeConfig(config, secrets);
  const saveConfig = (configValue = config, secretsValue = secrets) => persistence.save(configValue, secretsValue);

  /**
   * Team mode gets a persistent local Postgres-compatible index when the
   * operator has not supplied an external connection. The loopback port is
   * process-local, so refresh the generated URL after every app restart.
   */
  const ensureBuiltinTeamMemory = async (configValue) => {
    const orchestration = configValue?.orchestration;
    if (!localPostgres || orchestration?.defaultMode === "single") return configValue;
    const currentIndex = configValue.engine?.memory?.index;
    const hasExternalConnection = currentIndex?.backend === "postgres"
      && typeof currentIndex.connectionString === "string"
      && currentIndex.connectionString.trim()
      && currentIndex.connectionSource !== "builtin";
    if (hasExternalConnection) return configValue;
    try {
      const runtime = await localPostgres.ensure(configValue.workspace);
      if (runtime?.state !== "ready" || typeof runtime.connectionString !== "string") {
        console.warn("[kyrei] Team mode kept SQLite: local Postgres is unavailable", runtime?.error ?? "unknown_error");
        return configValue;
      }
      return normalizeGatewayConfig({
        ...configValue,
        engine: {
          ...(configValue.engine ?? {}),
          memory: {
            ...(configValue.engine?.memory ?? {}),
            index: {
              ...(currentIndex ?? {}),
              enabled: true,
              backend: "postgres",
              connectionString: runtime.connectionString,
              connectionSource: "builtin",
            },
          },
        },
      });
    } catch (error) {
      console.warn("[kyrei] Team mode kept SQLite: local Postgres bootstrap failed", error?.message ?? error);
      return configValue;
    }
  };

  // Rebind a previously configured built-in connection to this process's
  // fresh loopback port before the first Team request after application start.
  const bootstrappedConfig = await ensureBuiltinTeamMemory(config);
  if (bootstrappedConfig !== config) {
    config = bootstrappedConfig;
  }
  await saveConfig(config, secrets);

  const organizationWorker = kiroOrganizationWorker ?? new KiroOrganizationWorker({
    homeRoot: join(dataDir, "kiro-organization", "accounts"),
  });
  const organizationAuditPath = join(dataDir, "kiro-organization-audit.jsonl");
  let organizationAuditTail = Promise.resolve();
  const appendOrganizationAudit = (event) => {
    const line = `${JSON.stringify(event)}\n`;
    organizationAuditTail = organizationAuditTail.then(async () => {
      await appendFile(organizationAuditPath, line, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") await chmod(organizationAuditPath, 0o600);
    }).catch(() => undefined);
  };
  /** Durable multi-provider usage ledger (governance P0). Fail-open on write. */
  const usageLedger = createUsageLedger({ dataDir });
  /** Wave E: last coding-harness snapshot from a completed chat turn (no secrets). */
  let lastHarnessMetrics = null;
  const sanitizeHarnessMetrics = (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const n = (v) => {
      const x = Number(v);
      return Number.isFinite(x) && x >= 0 ? x : 0;
    };
    const s = (v, max = 64) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
    return {
      sessionId: s(raw.sessionId, 120),
      turns: n(raw.turns),
      toolPrunes: n(raw.toolPrunes),
      toolBytesRaw: n(raw.toolBytesRaw),
      toolBytesShown: n(raw.toolBytesShown),
      goalSkims: n(raw.goalSkims),
      workingStatePins: n(raw.workingStatePins),
      softOverflows: n(raw.softOverflows),
      hardOverflows: n(raw.hardOverflows),
      stageBSummaries: n(raw.stageBSummaries),
      longTaskPlanGates: n(raw.longTaskPlanGates),
      goalVerifies: n(raw.goalVerifies),
      intentRoute: s(raw.intentRoute, 40),
      intentReason: s(raw.intentReason, 80),
      postEditVerifies: n(raw.postEditVerifies),
      postEditFailures: n(raw.postEditFailures),
      symbolMapCacheHits: n(raw.symbolMapCacheHits),
      cacheBreakpoints: raw.cacheBreakpoints === true,
      wasteRatio: Number.isFinite(Number(raw.wasteRatio)) ? Number(raw.wasteRatio) : undefined,
      updatedAt: s(raw.updatedAt, 40),
    };
  };
  const recordChatUsage = (payload) => {
    void usageLedger.record(payload).catch(() => undefined);
  };
  /** Touch lastUsedAt for a principal (public metadata only). */
  const touchAccessPrincipal = (principalId) => {
    if (!principalId) return;
    const control = accessControlState();
    const nextPrincipals = control.principals.map((row) => (
      row.id === principalId
        ? { ...row, lastUsedAt: new Date().toISOString() }
        : row
    ));
    config = normalizeGatewayConfig({
      ...config,
      accessControl: { ...control, principals: nextPrincipals },
    });
    void saveConfig(config, secrets).catch(() => undefined);
  };
  async function usageBudgetSnapshot() {
    const budgetConfig = usageBudgetFromEngine(config.engine);
    const sinceMs = budgetWindowStartMs(budgetConfig.window);
    const events = await usageLedger.readEvents({ limit: 50_000, sinceMs });
    let totalTokens = 0;
    let costUsd = 0;
    for (const event of events) {
      totalTokens += Number(event.totalTokens) || 0;
      costUsd += Number(event.costUsd) || 0;
    }
    return evaluateUsageBudget(budgetConfig, {
      totalTokens,
      costUsd,
      requestCount: events.length,
    });
  }
  function accessControlState() {
    return normalizeAccessControl(config.accessControl);
  }
  function accessTokenHashes() {
    return normalizeAccessTokenHashes(secrets.accessTokenHashes);
  }
  /**
   * Resolve optional employee access token from the request.
   * When requireToken is on, missing/invalid tokens fail.
   */
  function resolveRequestPrincipal(req, { required = false } = {}) {
    const control = accessControlState();
    const plain = extractAccessTokenFromRequest(req);
    if (!plain) {
      if (required || control.requireToken) {
        throw new AccessTokenError("access_token_required", 401);
      }
      return null;
    }
    const resolved = resolveAccessPrincipal(plain, control, accessTokenHashes());
    if (!resolved) throw new AccessTokenError("access_token_invalid", 401);
    return resolved;
  }
  async function principalBudgetSnapshot(principal) {
    if (!principal) return null;
    const events = await usageLedger.readEvents({ limit: 50_000 });
    return evaluatePrincipalBudget(principal, events);
  }
  const kiroOrganizationBroker = new KiroOrganizationBroker({
    config: config.kiroOrganization,
    secrets: normalizeKiroOrganizationSecrets(secrets.kiroOrganization),
    worker: organizationWorker,
    protectedStorage: Boolean(secretsCodec),
    audit: appendOrganizationAudit,
  });

  let configMutationTail = Promise.resolve();
  const mutateConfig = operation => {
    const result = configMutationTail.then(operation);
    configMutationTail = result.catch(() => {});
    return result;
  };

  const KIRO_ORGANIZATION_ACCOUNT_INPUT_FIELDS = new Set([
    "id",
    "name",
    "enabled",
    "weight",
    "priority",
    "maxConcurrency",
    "modelIds",
    "projectIds",
  ]);
  const currentKiroOrganizationSecrets = () => (
    normalizeKiroOrganizationSecrets(secrets.kiroOrganization)
  );
  const forgetKiroOrganizationCredentialInMemory = (accountId) => {
    const nextSecrets = normalizeProviderSecrets(secrets);
    const organizationSecrets = normalizeKiroOrganizationSecrets(nextSecrets.kiroOrganization);
    organizationSecrets.delete(accountId);
    nextSecrets.kiroOrganization = serializeKiroOrganizationSecrets(organizationSecrets);
    secrets = nextSecrets;
  };
  const requireKiroOrganizationGeneration = (value) => {
    if (!Number.isSafeInteger(value) || value !== kiroOrganizationBroker.snapshot().generation) {
      throw kiroOrganizationError("kiro_organization_generation_conflict");
    }
  };
  const currentKiroOrganizationAccount = (accountId) => {
    const account = config.kiroOrganization.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw kiroOrganizationError("kiro_organization_account_not_found");
    return account;
  };
  const requireKiroOrganizationAccountRevision = (account, value) => {
    if (!Number.isSafeInteger(value) || value !== account.revision) {
      throw kiroOrganizationError("kiro_organization_revision_conflict");
    }
  };
  const requireKiroOrganizationProtectedStorage = () => {
    if (!secretsCodec) throw kiroOrganizationError("kiro_organization_protected_storage_required");
  };
  const commitKiroOrganizationState = async (organizationConfig, organizationSecrets) => {
    const normalizedOrganization = normalizeKiroOrganizationConfig(organizationConfig);
    const normalizedSecrets = normalizeKiroOrganizationSecrets(organizationSecrets);
    const nextConfig = normalizeGatewayConfig({
      ...config,
      kiroOrganization: normalizedOrganization,
    });
    const nextSecrets = normalizeProviderSecrets(secrets);
    nextSecrets.kiroOrganization = serializeKiroOrganizationSecrets(normalizedSecrets);
    await saveConfig(nextConfig, nextSecrets);
    config = nextConfig;
    secrets = nextSecrets;
    return kiroOrganizationBroker.reconfigure({
      config: normalizedOrganization,
      secrets: normalizedSecrets,
    });
  };
  const advanceKiroOrganizationCredentialRevision = (nextConfig, previousConfig, accountId) => {
    const previous = previousConfig.accounts.find((account) => account.id === accountId);
    const current = nextConfig.accounts.find((account) => account.id === accountId);
    if (!previous || !current) return nextConfig;
    const advance = (value) => {
      if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
        throw kiroOrganizationError("kiro_organization_revision_exhausted");
      }
      return value + 1;
    };
    const accountRevision = current.revision === previous.revision
      ? advance(previous.revision)
      : current.revision;
    const configRevision = nextConfig.revision === previousConfig.revision
      ? advance(previousConfig.revision)
      : nextConfig.revision;
    return normalizeKiroOrganizationConfig({
      ...nextConfig,
      revision: configRevision,
      accounts: nextConfig.accounts.map((account) => account.id === accountId
        ? { ...account, revision: accountRevision }
        : account),
    });
  };

  const store = new SessionStore({ runtimeDir: dataDir });
  await store.load();
  const runtimeSensitiveValuesFor = (configState = config, secretState = secrets) => (
    collectRuntimeSensitiveValues(configState, secretState)
  );
  const runtimeSensitiveValues = () => runtimeSensitiveValuesFor(config, secrets);

  // Dual-write chat → engine SessionStore. JSON remains write path for
  // approvals/rewind; enginePrimary (A4b) prefers engine for public GET.
  let sessionMirrorHandle = null;
  let sessionMirrorStores = null;
  let sessionMirrorInitPromise = null;
  let sessionMirrorUnavailableUntil = 0;
  let sessionMirrorWriteTail = Promise.resolve();
  let sessionMirrorSyncPromise = null;
  let sessionMirrorSyncStartPromise = null;
  let sessionMirrorSyncWriteTail = Promise.resolve();
  let gatewayClosing = false;
  const sessionMirrorSyncStatePath = join(dataDir, "session-mirror-sync.json");
  const emptySessionMirrorSyncState = () => ({
    version: 1,
    state: "idle",
    entries: [],
    nextIndex: 0,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    error: null,
  });
  const normalizeSessionMirrorSyncState = (value) => {
    const source = isPlainRecord(value) ? value : {};
    const entries = Array.isArray(source.entries)
      ? source.entries
        .filter((entry) => isPlainRecord(entry) && typeof entry.id === "string" && entry.id.trim())
        .map((entry) => ({
          id: entry.id.trim().slice(0, 128),
          messages: Math.max(0, Math.min(1_000_000, Number(entry.messages) || 0)),
        }))
      : [];
    const state = ["idle", "running", "completed", "failed"].includes(source.state)
      ? source.state
      : "idle";
    const nextIndex = Math.min(
      entries.length,
      Math.max(0, Math.floor(Number(source.nextIndex) || 0)),
    );
    return {
      version: 1,
      state,
      entries,
      nextIndex,
      startedAt: typeof source.startedAt === "string" ? source.startedAt : null,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
      completedAt: typeof source.completedAt === "string" ? source.completedAt : null,
      error: typeof source.error === "string" ? source.error.slice(0, 500) : null,
    };
  };
  let sessionMirrorSyncState = emptySessionMirrorSyncState();
  const sessionMirrorSyncStateReady = (async () => {
    try {
      const raw = await readFile(sessionMirrorSyncStatePath, "utf8");
      sessionMirrorSyncState = normalizeSessionMirrorSyncState(JSON.parse(raw));
    } catch {
      sessionMirrorSyncState = emptySessionMirrorSyncState();
    }
  })();
  const sessionMirrorSyncProgress = () => {
    const entries = sessionMirrorSyncState.entries;
    const completedSessions = Math.min(sessionMirrorSyncState.nextIndex, entries.length);
    const completedMessages = entries
      .slice(0, completedSessions)
      .reduce((total, entry) => total + entry.messages, 0);
    return {
      state: sessionMirrorSyncState.state,
      totalSessions: entries.length,
      completedSessions,
      totalMessages: entries.reduce((total, entry) => total + entry.messages, 0),
      completedMessages,
      ...(sessionMirrorSyncState.startedAt ? { startedAt: sessionMirrorSyncState.startedAt } : {}),
      ...(sessionMirrorSyncState.updatedAt ? { updatedAt: sessionMirrorSyncState.updatedAt } : {}),
      ...(sessionMirrorSyncState.completedAt ? { completedAt: sessionMirrorSyncState.completedAt } : {}),
      ...(sessionMirrorSyncState.error ? { error: sessionMirrorSyncState.error } : {}),
      resumable: sessionMirrorSyncState.state === "running" || (
        sessionMirrorSyncState.state === "failed" && completedSessions < entries.length
      ),
    };
  };
  const persistSessionMirrorSyncState = () => {
    const snapshot = JSON.stringify(sessionMirrorSyncState, null, 2);
    const write = async () => {
      await mkdir(dirname(sessionMirrorSyncStatePath), { recursive: true });
      const temp = `${sessionMirrorSyncStatePath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temp, snapshot, "utf8");
        await rename(temp, sessionMirrorSyncStatePath);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
    };
    const operation = sessionMirrorSyncWriteTail.then(write, write);
    sessionMirrorSyncWriteTail = operation.catch(() => undefined);
    return operation;
  };
  const withSessionMirrorWriteLock = (operation) => {
    const queued = sessionMirrorWriteTail.then(operation, operation);
    sessionMirrorWriteTail = queued.catch(() => undefined);
    return queued;
  };
  const sessionMirrorConfig = () => {
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const memory = isPlainRecord(engine.memory) ? engine.memory : {};
    const mirror = isPlainRecord(memory.sessionMirror) ? memory.sessionMirror : {};
    return {
      enabled: mirror.enabled !== false,
      readSearch: mirror.readSearch !== false,
      // Align with DEFAULT_ENGINE_CONFIG (true) and UI: missing key = on.
      enginePrimary: mirror.enginePrimary !== false,
    };
  };
  const sessionMirrorEnabled = () => sessionMirrorConfig().enabled;
  const sessionMirrorEnginePrimary = () => sessionMirrorConfig().enabled && sessionMirrorConfig().enginePrimary;
  const ensureSessionMirror = async () => {
    if (!sessionMirrorEnabled()) return null;
    if (sessionMirrorHandle) return sessionMirrorHandle;
    if (Date.now() < sessionMirrorUnavailableUntil) return null;
    if (sessionMirrorInitPromise) return sessionMirrorInitPromise;
    sessionMirrorInitPromise = (async () => {
      try {
        const mod = await getEngine();
        if (typeof mod?.createStores !== "function" || typeof mod?.createSessionMirror !== "function") {
          sessionMirrorUnavailableUntil = Date.now() + 5_000;
          return null;
        }
        sessionMirrorStores = mod.createStores(join(dataDir, "session-mirror"));
        sessionMirrorHandle = mod.createSessionMirror({
          sessions: sessionMirrorStores.sessions,
          jsonlPathPrefix: `gateway://${dataDir.replace(/\\/g, "/")}/sessions`,
          sensitiveValues: runtimeSensitiveValues(),
        });
        sessionMirrorUnavailableUntil = 0;
        return sessionMirrorHandle;
      } catch (error) {
        sessionMirrorUnavailableUntil = Date.now() + 5_000;
        console.warn("[kyrei session-mirror] unavailable:", error?.message ?? error);
        return null;
      } finally {
        sessionMirrorInitPromise = null;
      }
    })();
    return sessionMirrorInitPromise;
  };
  const mirrorSessionDescriptor = (session) => ({
    id: session.id,
    title: session.title,
    workspace: typeof config.workspace === "string" ? config.workspace : undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    providerId: session.providerId,
    modelId: session.modelId,
    providerAccountId: session.providerAccountId,
    archived: session.archived === true,
    ...(session.archived === true && typeof session.archivedAt === "string"
      ? { archivedAt: session.archivedAt }
      : {}),
    ...(typeof session.parentSessionId === "string" && session.parentSessionId
      ? { parentSessionId: session.parentSessionId }
      : {}),
    ...(typeof session.rootSessionId === "string" && session.rootSessionId
      ? { rootSessionId: session.rootSessionId }
      : {}),
    ...(typeof session.forkedFromMessageId === "string" && session.forkedFromMessageId
      ? { forkedFromMessageId: session.forkedFromMessageId }
      : {}),
    ...(typeof session.forkedAt === "string" && session.forkedAt
      ? { forkedAt: session.forkedAt }
      : {}),
    ...(session.lineageKind === "branch" ? { lineageKind: "branch" } : {}),
  });
  const mirrorSessionMessages = (sessionId) => store.getMessages(sessionId).map((message) => ({
    id: message.id,
    role: message.role,
    text:
      typeof message.text === "string" && message.text.trim()
        ? message.text
        : typeof message.content === "string" && message.content.trim()
          ? message.content
          : Array.isArray(message.parts)
            ? textFromTurnParts(message.parts)
            : "",
    at: message.at,
    parts: message.parts,
    pending: message.pending === true,
    turnStatus: message.turnStatus,
    approvalModelParams: message.approvalModelParams,
  }));
  /**
   * Dual-write one session JSON → engine mirror.
   * @returns {{ ok: boolean, error?: string, skipped?: boolean }}
   */
  const mirrorGatewaySession = async (sessionId) => {
    return withSessionMirrorWriteLock(async () => {
      try {
        const mirror = await ensureSessionMirror();
        if (!mirror) {
        // infrastructure: SQLite/engine never opened — cannot dual-write (not a write failure).
          return sessionMirrorEnabled()
            ? { ok: false, error: "mirror_unavailable", infrastructure: true }
            : { ok: true, skipped: true };
        }
        const session = store.getSession(sessionId);
        if (!session) return { ok: false, error: "session_not_found" };
        await mirror.syncSession(mirrorSessionDescriptor(session), mirrorSessionMessages(sessionId));
        return { ok: true };
      } catch (error) {
        const message = error?.message ?? "mirror_write_failed";
        console.warn("[kyrei session-mirror] write failed:", message);
        return { ok: false, error: message };
      }
    });
  };
  const removeGatewaySessionFromMirror = async (sessionId) => withSessionMirrorWriteLock(async () => {
    const mirror = await ensureSessionMirror();
    if (!mirror || typeof mirror.removeSession !== "function") return false;
    await mirror.removeSession(sessionId);
    return true;
  });
  const runSessionMirrorSync = async () => {
    try {
      for (let index = sessionMirrorSyncState.nextIndex; index < sessionMirrorSyncState.entries.length; index += 1) {
        // Do not race gateway shutdown with an open SQLite handle. Keep the
        // durable cursor at the last completed session so startup resumes it.
        if (gatewayClosing) {
          await persistSessionMirrorSyncState();
          return;
        }
        const entry = sessionMirrorSyncState.entries[index];
        const session = entry ? store.getSession(entry.id) : null;
        if (session) {
          const result = await mirrorGatewaySession(session.id);
          // A session can be permanently deleted while the queued job waits
          // for the mirror write lock. It is no longer part of JSON SoT, so
          // treating that one entry as completed is correct and idempotent.
          if (!result.ok && result.error !== "session_not_found") {
            throw new Error(result.error ?? "mirror_sync_failed");
          }
        }
        sessionMirrorSyncState = {
          ...sessionMirrorSyncState,
          nextIndex: index + 1,
          updatedAt: new Date().toISOString(),
          error: null,
        };
        // Persist after each replace-on-sync. If the app exits between rows,
        // re-running the last row is safe; skipping an unfinished row is not.
        await persistSessionMirrorSyncState();
        // Give status/search requests and interactive dual-writes a chance to
        // run between sessions instead of monopolizing the event loop.
        await new Promise((resolveYield) => setImmediate(resolveYield));
      }
      if (!gatewayClosing) {
        const finishedAt = new Date().toISOString();
        sessionMirrorSyncState = {
          ...sessionMirrorSyncState,
          state: "completed",
          nextIndex: sessionMirrorSyncState.entries.length,
          updatedAt: finishedAt,
          completedAt: finishedAt,
          error: null,
        };
        await persistSessionMirrorSyncState();
      }
    } catch (error) {
      // Preserve the completed cursor: a later click can retry only the
      // remaining sessions, and malformed/secret-bearing diagnostics never
      // escape into Settings or the state file.
      const message = redactSensitiveText(
        error?.message ?? "mirror_sync_failed",
        runtimeSensitiveValues(),
      ).slice(0, 500);
      sessionMirrorSyncState = {
        ...sessionMirrorSyncState,
        state: gatewayClosing ? "running" : "failed",
        updatedAt: new Date().toISOString(),
        error: gatewayClosing ? null : message,
      };
      await persistSessionMirrorSyncState().catch(() => undefined);
      if (!gatewayClosing) console.warn("[kyrei session-mirror] background sync paused:", message);
    } finally {
      sessionMirrorSyncPromise = null;
    }
  };
  const ensureSessionMirrorSyncRunning = () => {
    if (sessionMirrorSyncPromise || sessionMirrorSyncState.state !== "running") {
      return sessionMirrorSyncPromise;
    }
    sessionMirrorSyncPromise = runSessionMirrorSync();
    return sessionMirrorSyncPromise;
  };
  const startOrResumeSessionMirrorSync = async () => {
    await sessionMirrorSyncStateReady;
    if (sessionMirrorSyncStartPromise) return sessionMirrorSyncStartPromise;
    if (sessionMirrorSyncState.state === "running") {
      ensureSessionMirrorSyncRunning();
      return { accepted: true, alreadyRunning: true, resumed: false, ...sessionMirrorSyncProgress() };
    }
    sessionMirrorSyncStartPromise = (async () => {
      const canResume = sessionMirrorSyncState.state === "failed"
        && sessionMirrorSyncState.nextIndex < sessionMirrorSyncState.entries.length;
      if (canResume) {
        sessionMirrorSyncState = {
          ...sessionMirrorSyncState,
          state: "running",
          updatedAt: new Date().toISOString(),
          completedAt: null,
          error: null,
        };
      } else {
        const entries = (Array.isArray(store.sessions) ? [...store.sessions] : [])
          .filter((session) => typeof session?.id === "string" && session.id)
          .map((session) => ({ id: session.id, messages: store.getMessages(session.id).length }))
          .sort((left, right) => left.id.localeCompare(right.id));
        const startedAt = new Date().toISOString();
        sessionMirrorSyncState = {
          version: 1,
          state: "running",
          entries,
          nextIndex: 0,
          startedAt,
          updatedAt: startedAt,
          completedAt: null,
          error: null,
        };
      }
      await persistSessionMirrorSyncState();
      ensureSessionMirrorSyncRunning();
      return {
        accepted: true,
        alreadyRunning: false,
        resumed: canResume,
        ...sessionMirrorSyncProgress(),
      };
    })();
    try {
      return await sessionMirrorSyncStartPromise;
    } finally {
      sessionMirrorSyncStartPromise = null;
    }
  };
  /**
   * A4c write-through: when enginePrimary, require engine dual-commit after JSON mutation.
   * When not primary, fail-open dual-write (best effort).
   */
  const commitSessionToEngine = async (sessionId, { required } = {}) => {
    const must = required ?? sessionMirrorEnginePrimary();
    if (!sessionMirrorEnabled()) {
      return must ? { ok: false, error: "session_mirror_disabled" } : { ok: true, skipped: true };
    }
    const result = await mirrorGatewaySession(sessionId);
    if (result.ok) return result;
    // Primary without a working mirror store cannot be enforced — degrade gracefully.
    // Real write failures after open still fail closed when must=true.
    if (result.infrastructure || result.error === "mirror_unavailable") {
      if (!sessionMirrorHandle) {
        // one-shot log; avoid spamming every turn in tests / degraded installs
        if (!globalThis.__kyreiMirrorInfraWarned) {
          globalThis.__kyreiMirrorInfraWarned = true;
          console.warn(
            "[kyrei session-mirror] enginePrimary on but mirror unavailable; fail-open dual-write:",
            result.error,
          );
        }
      }
      return { ok: true, skipped: true, warning: result.error };
    }
    if (must) return result;
    return { ok: true, skipped: true, warning: result.error };
  };

  // ── Inbound messaging webhook (opt-in) ─────────────────────────────
  const messagingRecent = [];
  const messagingConfig = () => {
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    return normalizeMessagingConfig(engine.messaging);
  };
  const messagingTokenEquals = (provided) => {
    const expected = typeof secrets?.messaging?.webhookToken === "string"
      ? secrets.messaging.webhookToken.trim()
      : "";
    if (!expected || expected.length < 16) return false;
    const got = typeof provided === "string" ? provided.trim() : "";
    if (!got || got.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    } catch {
      return false;
    }
  };
  const extractMessagingToken = (req, body) => {
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
    const header = req.headers["x-kyrei-messaging-token"];
    if (typeof header === "string") return header.trim();
    if (body && typeof body.token === "string") return body.token.trim();
    return "";
  };
  const pushMessagingRecent = (entry) => {
    messagingRecent.unshift(entry);
    if (messagingRecent.length > 40) messagingRecent.length = 40;
  };

  /** A4b public list: prefer engine rows when enginePrimary, union with JSON backup. */
  const listSessionsForApi = async ({ includeArchived = false, archivedOnly = false } = {}) => {
    const decorate = (list) => (Array.isArray(list) ? list : []).map((s) => ({
      ...s,
      status: runtimeStatus.get(s.id) || "idle",
      ...(runtimeActivity.has(s.id) ? { activity: runtimeActivity.get(s.id) } : {}),
    }));
    const filterArchive = (list) => {
      if (archivedOnly) return list.filter((s) => s?.archived === true);
      if (includeArchived) return list;
      return list.filter((s) => s?.archived !== true);
    };
    const jsonSessions = Array.isArray(store.sessions) ? store.sessions : [];
    if (!sessionMirrorEnginePrimary()) {
      return decorate(filterArchive(jsonSessions));
    }
    try {
      const mirror = await ensureSessionMirror();
      if (!mirror || !sessionMirrorStores?.sessions) {
        return decorate(filterArchive(jsonSessions));
      }
      const engRecs = await mirror.listSessions({ limit: 2_000 });
      const engMapped = engRecs.map((r) => engineSessionToGateway(r)).filter(Boolean);
      const merged = mergeSessionsPreferEngine(jsonSessions, engMapped);
      // Prefer JSON archive flag when present (SoT for soft-archive UI).
      const withArchive = merged.map((s) => {
        const j = jsonSessions.find((x) => x?.id === s.id);
        if (!j) return s;
        return {
          ...s,
          archived: j.archived === true,
          ...(j.archived === true && j.archivedAt ? { archivedAt: j.archivedAt } : {}),
        };
      });
      return decorate(filterArchive(withArchive));
    } catch (error) {
      console.warn("[kyrei session-mirror] enginePrimary list fallback to JSON:", error?.message ?? error);
      return decorate(filterArchive(jsonSessions));
    }
  };

  /** A4b public messages: prefer engine when caught up; else JSON (approvals/in-flight). */
  const getMessagesForApi = async (sessionId) => {
    const jsonMessages = store.getMessages(sessionId);
    if (!sessionMirrorEnginePrimary()) return jsonMessages;
    try {
      const mirror = await ensureSessionMirror();
      if (!mirror || !sessionMirrorStores?.sessions) return jsonMessages;
      const engRows = await sessionMirrorStores.sessions.getMessages(sessionId);
      const engMapped = (engRows || []).map((m) => engineMessageToGateway(m, sessionId)).filter(Boolean);
      const { messages } = preferMessagesForPrimary(jsonMessages, engMapped);
      return messages;
    } catch (error) {
      console.warn("[kyrei session-mirror] enginePrimary messages fallback to JSON:", error?.message ?? error);
      return jsonMessages;
    }
  };

  /**
   * Source messages for mutation algorithms. With enginePrimary, prefer engine
   * when caught up so approval/rewind run on engine-backed history.
   */
  const loadMessagesForMutation = async (sessionId) => {
    const jsonMessages = store.getMessages(sessionId);
    if (!sessionMirrorEnginePrimary()) return { messages: jsonMessages, source: "json" };
    try {
      await ensureSessionMirror();
      if (!sessionMirrorStores?.sessions) return { messages: jsonMessages, source: "json" };
      const engRows = await sessionMirrorStores.sessions.getMessages(sessionId);
      const engMapped = (engRows || []).map((m) => engineMessageToGateway(m, sessionId)).filter(Boolean);
      const preferred = preferMessagesForPrimary(jsonMessages, engMapped);
      return { messages: preferred.messages, source: preferred.source };
    } catch {
      return { messages: jsonMessages, source: "json" };
    }
  };

  /**
   * Persist mutation result: JSON list + dual-commit engine (strict when primary).
   */
  const persistMutatedMessages = async (sessionId, messages) => {
    store.replaceMessages(sessionId, messages);
    await store.flush();
    const commit = await commitSessionToEngine(sessionId, { required: sessionMirrorEnginePrimary() });
    if (!commit.ok && sessionMirrorEnginePrimary()) {
      const err = new Error(commit.error ?? "engine_mirror_write_failed");
      err.code = "engine_mirror_write_failed";
      throw err;
    }
    return commit;
  };
  const resolutionReceiptRegistry = new WeakSet();
  const actionReceiptRegistry = new WeakSet();
  const truthGateReceiptRegistry = new WeakSet();
  const isVerifiedResolution = (marker) => Boolean(marker && typeof marker === "object" && resolutionReceiptRegistry.has(marker));
  const isVerifiedActionReceipt = (receipt) => Boolean(receipt && typeof receipt === "object" && actionReceiptRegistry.has(receipt));
  const isVerifiedTruthGate = (receipt) => Boolean(receipt && typeof receipt === "object" && truthGateReceiptRegistry.has(receipt));
  const teamRunStore = new TeamRunStore({ dataDir, getSensitiveValues: runtimeSensitiveValues });
  await teamRunStore.recoverInterrupted().catch(() => []);
  const pipelineRunStore = new PipelineRunStore({
    dataDir,
    getSensitiveValues: runtimeSensitiveValues,
    isVerifiedResolution,
    isVerifiedActionReceipt,
    isVerifiedTruthGate,
  });
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

  function normalizePromptSkillIds(value) {
    if (value == null) return undefined;
    if (!Array.isArray(value)) throw new TypeError("prompt_skills_invalid");

    const seen = new Set();
    const ids = [];
    for (const candidate of value) {
      if (typeof candidate !== "string" || !PROMPT_SKILL_ID_RE.test(candidate)) {
        throw new TypeError("prompt_skills_invalid");
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        ids.push(candidate);
      }
    }
    if (ids.length > MAX_PROMPT_SKILLS) throw new TypeError("prompt_skills_limit_exceeded");
    return ids.length ? ids : undefined;
  }

  async function validatePromptSkillIds(value) {
    const ids = normalizePromptSkillIds(value);
    if (!ids) return undefined;
    const available = new Set((await skillsStore.list())
      .filter((skill) => skill.enabled)
      .map((skill) => skill.id));
    if (ids.some((id) => !available.has(id))) throw new TypeError("prompt_skill_unavailable");
    return ids;
  }

  function runtimeSkillsForPrompt(skillIds, { strictRequested = false } = {}) {
    return skillIds?.length
      ? skillsStore.runtimeSkills({ ids: skillIds, maxSkills: MAX_PROMPT_SKILLS, strictRequested })
      : skillsStore.runtimeSkills();
  }

  const buildPipelineRuntimeIdentity = async (definition, configSnapshot = config, secretsSnapshot = secrets) => {
    const profiles = referencedProfilesForDefinition(definition, configSnapshot.orchestration.profiles);
    if (profiles.some((profile) => profile.missing === true || profile.enabled !== true)) {
      throw pipelineConflict("pipeline_runtime_unavailable");
    }
    const skillIds = [...new Set(profiles.flatMap((profile) => teamProfileSkillIds(profile)))].sort();
    let skillIdentity;
    try {
      skillIdentity = await skillsStore.runtimeIdentity({
        ids: skillIds,
        maxSkills: MAX_TEAM_PROFILE_SKILLS,
      });
    } catch {
      throw pipelineConflict("pipeline_runtime_unavailable");
    }
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
      const readyAccountIds = new Set(readyProviderAccounts(provider, secretsSnapshot, configSnapshot).map((account) => account.id));
      return {
        id,
        protocol: provider.protocol,
        baseURL: provider.baseURL,
        enabled: provider.enabled,
        ready: providerIsReady(provider, secretsSnapshot, configSnapshot),
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
    if (unavailableTarget || skillIdentity.complete !== true) {
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
      skillIdentity: {
        version: skillIdentity.version,
        digest: skillIdentity.digest,
        bytes: skillIdentity.bytes,
        skills: skillIdentity.skills,
      },
      engine: configSnapshot.engine ?? {},
      sandbox,
      runtimeBuildId: String(runtimeBuildId),
      engineContractVersion: 1,
      pipelineRuntimeVersion: 2,
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
  const activeTurns = new Map(); // sessionId -> controller + durable assistant draft + completion
  const sessionReservations = new Map(); // sessionId -> opaque owner token
  const runtimeStatus = new Map(); // sessionId -> "working" (absent = idle)
  const runtimeActivity = new Map(); // sessionId -> public live/last turn activity
  const activePromptProviders = new Map(); // sessionId -> provider ids whose credentials may be in flight
  const subagentRuns = new Map(); // subagentId -> cross-session runtime summary
  /** Session-scoped protected-path allow-once (after tool approval). Survives rest of session only. */
  const sessionProtectedAllowOnce = new Map(); // sessionId -> string[]
  const shutdownController = new AbortController();
  const activeHttpRequests = new Set();

  const noteProtectedPathAllowOnce = (sessionId, approval) => {
    if (!sessionId || !approval || approval.status !== "approved") return;
    const name = approval.name;
    if (name !== "write_file" && name !== "edit_file") return;
    const raw = typeof approval.args?.path === "string"
      ? approval.args.path
      : typeof approval.args?.file === "string"
        ? approval.args.file
        : "";
    const path = raw.replaceAll("\\", "/").trim();
    if (!path) return;
    const list = sessionProtectedAllowOnce.get(sessionId) ?? [];
    if (list.includes(path)) return;
    list.push(path);
    sessionProtectedAllowOnce.set(sessionId, list.slice(0, 200));
  };

  const engineConfigForSession = (sessionId) => {
    const base = isPlainRecord(config.engine) ? config.engine : {};
    const session = store.getSession(sessionId);
    const sessionMode = session?.codingMode;
    const withMode = sessionMode
      && (sessionMode === "auto" || sessionMode === "plan" || sessionMode === "build"
        || sessionMode === "polish" || sessionMode === "deepreep")
      ? { ...base, codingMode: sessionMode }
      : base;
    const allowOnce = sessionProtectedAllowOnce.get(sessionId) ?? [];
    if (!allowOnce.length) return withMode;
    const permissions = isPlainRecord(withMode.permissions) ? withMode.permissions : {};
    const existing = Array.isArray(permissions.protectedPathAllowOnce)
      ? permissions.protectedPathAllowOnce
      : [];
    const merged = [...existing];
    for (const p of allowOnce) {
      if (!merged.includes(p)) merged.push(p);
    }
    return {
      ...withMode,
      permissions: {
        ...permissions,
        protectedPathAllowOnce: merged.slice(0, 200),
      },
    };
  };

  const gatewayShutdownError = () => {
    const error = new Error("gateway_shutdown");
    error.code = "gateway_shutdown";
    return error;
  };

  // `readBody` observes this signal while a request is incomplete.  A body can
  // still finish in the same event-loop turn in which shutdown begins, though,
  // so every state-changing request needs a second boundary immediately before
  // it touches SessionStore.  This keeps a late approval/PATCH from scheduling
  // a new flush after close() has drained the stores.
  const assertGatewayAcceptingMutations = () => {
    if (gatewayClosing || shutdownController.signal.aborted) throw gatewayShutdownError();
  };

  const waitForHttpRequests = async () => {
    // A handler can cause another short local request while it settles. Keep
    // draining until no mutation-capable handler remains, then close stores.
    while (activeHttpRequests.size) {
      await Promise.allSettled([...activeHttpRequests].map((request) => request.done));
    }
  };

  // The engine is a built ESM bundle, loaded lazily on first prompt.
  let engine = null;
  const getEngine = async () => {
    if (!engine) engine = await engineLoader();
    return engine;
  };
  // A crash or app update may stop an active job between sessions. The state
  // file deliberately stays "running" in that case, so a later gateway boot
  // resumes the exact immutable session plan without repeating completed work.
  // Schedule this only after the lazy engine accessor exists.
  void sessionMirrorSyncStateReady.then(() => {
    if (sessionMirrorSyncState.state === "running" && !gatewayClosing) ensureSessionMirrorSyncRunning();
  });

  /**
   * Read the optional local GBrain runtime without enabling its tools. This is
   * deliberately a health-only operation: it never sends a provider key,
   * writes personal knowledge, or starts an installer.
   */
  const gbrainHealthCache = { key: "", at: 0, value: null, promise: null };
  const inspectGBrain = async ({ command, force = false } = {}) => {
    const configured = configuredGBrainRuntime(config.engine);
    const gbrain = typeof command === "string" && command.trim() && command.length <= 1_024
      ? { ...configured, command: command.trim() }
      : configured;
    const key = `${gbrain.provider}|${gbrain.command ?? ""}|${gbrain.timeoutMs}|${gbrain.maxOutputBytes}`;
    const now = Date.now();
    if (!force && gbrainHealthCache.key === key && gbrainHealthCache.value && now - gbrainHealthCache.at < 5_000) {
      return gbrainHealthCache.value;
    }
    if (!force && gbrainHealthCache.key === key && gbrainHealthCache.promise) {
      return gbrainHealthCache.promise;
    }
    const probe = (async () => {
      let mod;
      try {
        mod = await getEngine();
      } catch {
        return { state: "unavailable", provider: gbrain.provider, mode: gbrain.mode, reason: "adapter_unavailable", doctorStatus: "unknown" };
      }
      if (gbrain.provider === "builtin") {
        if (typeof mod?.inspectBuiltinGBrainStore !== "function") {
          return { state: "unavailable", provider: gbrain.provider, mode: gbrain.mode, reason: "adapter_unavailable", doctorStatus: "unknown" };
        }
        try {
          const inspected = mod.inspectBuiltinGBrainStore(join(dataDir, "memory"));
          return {
            state: inspected.initialized ? "ready" : "not_initialized",
            provider: gbrain.provider,
            mode: gbrain.mode,
            doctorStatus: inspected.initialized ? "ok" : "warnings",
          };
        } catch {
          return { state: "error", provider: gbrain.provider, mode: gbrain.mode, reason: "check_failed", doctorStatus: "unknown" };
        }
      }
      if (typeof mod?.createGBrainClient !== "function") {
        return { state: "unavailable", provider: gbrain.provider, mode: gbrain.mode, reason: "adapter_unavailable", doctorStatus: "unknown" };
      }
      try {
        // Source scoping is an agent-search preference. A health check must not
        // become "not ready" simply because a user has not created that source.
        const client = mod.createGBrainClient({
          mode: "read",
          command: gbrain.command,
          timeoutMs: Math.min(gbrain.timeoutMs, 60_000),
          maxOutputBytes: gbrain.maxOutputBytes,
        });
        const doctor = await client.doctor();
        return { ...gbrainDoctorState(doctor), provider: gbrain.provider, mode: gbrain.mode };
      } catch (error) {
        return { ...gbrainFailureState(error), provider: gbrain.provider, mode: gbrain.mode, doctorStatus: "unknown" };
      }
    })();
    gbrainHealthCache.key = key;
    gbrainHealthCache.promise = probe;
    try {
      const result = await probe;
      gbrainHealthCache.value = result;
      gbrainHealthCache.at = Date.now();
      return result;
    } finally {
      if (gbrainHealthCache.promise === probe) gbrainHealthCache.promise = null;
    }
  };

  const persistGBrainConfig = async (patch) => mutateConfig(async () => {
    const currentEngine = isPlainRecord(config.engine) ? config.engine : {};
    const currentMemory = isPlainRecord(currentEngine.memory) ? currentEngine.memory : {};
    const nextEngine = validateEngineConfigBoundary({
      ...currentEngine,
      memory: {
        ...currentMemory,
        gbrain: { ...configuredGBrainRuntime(currentEngine), ...patch },
      },
    });
    const nextConfig = { ...config, engine: nextEngine };
    await saveConfig(nextConfig, secrets);
    config = nextConfig;
    return publicConfig();
  });

  const inspectMcp = async () => {
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const raw = isPlainRecord(engine.mcp) ? engine.mcp : {};
    if (raw.enabled !== true) return { enabled: false, state: "disabled", servers: [] };
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return { enabled: true, state: "error", servers: [], message: "adapter_unavailable" };
    }
    if (typeof mod?.normalizeMcpConfig !== "function" || typeof mod?.createMcpManager !== "function") {
      return { enabled: true, state: "error", servers: [], message: "adapter_unavailable" };
    }
    const mcpConfig = mod.normalizeMcpConfig(raw);
    if (!mcpConfig.servers.length) return { enabled: true, state: "no_servers", servers: [], message: "no_servers" };
    const manager = mod.createMcpManager({
      config: mcpConfig,
      sensitiveValues: runtimeSensitiveValues(),
    });
    try {
      const servers = await manager.inspectServers();
      return {
        enabled: true,
        state: servers.every((server) => server.ok) ? "ready" : "error",
        servers: servers.map((server) => ({
          ...server,
          ...(server.error ? { error: redactSensitiveText(server.error, runtimeSensitiveValues()) } : {}),
        })),
      };
    } finally {
      await manager.close().catch(() => undefined);
    }
  };

  /**
   * Explicitly create GBrain's local PGLite store. This endpoint is never
   * invoked during startup and intentionally does not install a CLI or prompt
   * for external credentials. A completed health check is required before the
   * agent's read tools are enabled.
   */
  const initializeGBrain = async () => {
    const before = await inspectGBrain({ force: true });
    if (before.state === "ready") {
      if (before.mode === "read" || before.mode === "read-write") return { status: before, config: publicConfig() };
      const snapshot = await persistGBrainConfig({ mode: "read" });
      return { status: { ...before, mode: "read" }, config: snapshot };
    }
    const gbrain = configuredGBrainRuntime(config.engine);
    if (gbrain.provider === "builtin") {
      let mod;
      try {
        mod = await getEngine();
      } catch {
        throw gbrainGatewayError("gbrain_adapter_unavailable");
      }
      if (typeof mod?.initializeBuiltinGBrainStore !== "function") throw gbrainGatewayError("gbrain_adapter_unavailable");
      try {
        await mod.initializeBuiltinGBrainStore(join(dataDir, "memory"));
      } catch {
        throw gbrainGatewayError("gbrain_initialization_failed");
      }
      const after = await inspectGBrain({ force: true });
      if (after.state !== "ready") throw gbrainGatewayError("gbrain_initialization_unverified");
      const snapshot = await persistGBrainConfig({ provider: "builtin", mode: "read" });
      return { status: { ...after, mode: "read" }, config: snapshot };
    }
    if (before.state === "unavailable") throw gbrainGatewayError("gbrain_command_unavailable");
    if (before.state !== "not_initialized") throw gbrainGatewayError("gbrain_initialization_unavailable");

    let mod;
    try {
      mod = await getEngine();
    } catch {
      throw gbrainGatewayError("gbrain_adapter_unavailable");
    }
    if (typeof mod?.runGBrainProcess !== "function") throw gbrainGatewayError("gbrain_adapter_unavailable");

    try {
      await mod.runGBrainProcess(gbrain.command, ["init", "--pglite", "--no-embedding"], {
        signal: shutdownController.signal,
        timeoutMs: Math.min(Math.max(gbrain.timeoutMs, 60_000), 300_000),
        maxOutputBytes: Math.max(gbrain.maxOutputBytes, 200_000),
      });
    } catch (error) {
      const failure = gbrainFailureState(error);
      if (failure.state === "unavailable") throw gbrainGatewayError("gbrain_command_unavailable");
      throw gbrainGatewayError("gbrain_initialization_failed");
    }

    const after = await inspectGBrain({ force: true });
    if (after.state !== "ready") throw gbrainGatewayError("gbrain_initialization_unverified");
    const snapshot = await persistGBrainConfig({ mode: "read" });
    return { status: { ...after, mode: "read" }, config: snapshot };
  };

  /**
   * Explicit recovery path for first-run desktop installs. It is deliberately
   * tied to a button/API action: no network package operation occurs while the
   * app starts or merely checks status.
   */
  const installAndInitializeGBrain = async () => {
    const gbrain = configuredGBrainRuntime(config.engine);
    // Kept as a backwards-compatible endpoint for older clients. For the
    // built-in provider it provisions locally; it never downloads software.
    if (gbrain.provider === "builtin") return initializeGBrain();
    const before = await inspectGBrain({ force: true });
    if (before.state === "ready" || before.state === "not_initialized") return initializeGBrain();
    throw gbrainGatewayError("gbrain_external_setup_required");
  };

  /** Built-in project memory index (FTS + lexical vectors). Never replaces file SoT. */
  const builtinMemoryIndexConfig = () => {
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const memory = isPlainRecord(engine.memory) ? engine.memory : {};
    const index = isPlainRecord(memory.index) ? memory.index : {};
    const backend = index.backend === "postgres" || index.backend === "off" || index.backend === "sqlite"
      ? index.backend
      : "sqlite";
    const embed = isPlainRecord(index.embed) ? index.embed : {};
    const embedMode = embed.mode === "http" ? "http" : "lexical";
    return {
      enabled: index.enabled !== false,
      backend,
      ...(typeof index.connectionString === "string" && index.connectionString.trim()
        ? { connectionString: index.connectionString.trim() }
        : {}),
      embed: {
        mode: embedMode,
        ...(typeof embed.baseURL === "string" && embed.baseURL.trim() ? { baseURL: embed.baseURL.trim() } : {}),
        ...(typeof embed.model === "string" && embed.model.trim() ? { model: embed.model.trim() } : {}),
        ...(typeof embed.apiKey === "string" && embed.apiKey.trim() ? { apiKey: embed.apiKey.trim() } : {}),
        ...(Number.isFinite(embed.timeoutMs) ? { timeoutMs: embed.timeoutMs } : {}),
        ...(Number.isFinite(embed.dim) ? { dim: embed.dim } : {}),
      },
    };
  };

  const inspectBuiltinMemoryIndexRaw = async () => {
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return {
        state: "error",
        enabled: true,
        backend: "off",
        configuredBackend: "sqlite",
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
        message: "adapter_unavailable",
      };
    }
    if (typeof mod?.inspectWorkspaceMemoryIndex !== "function") {
      return {
        state: "error",
        enabled: true,
        backend: "off",
        configuredBackend: "sqlite",
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
        message: "adapter_unavailable",
      };
    }
    return mod.inspectWorkspaceMemoryIndex({
      workspace: typeof config.workspace === "string" ? config.workspace : "",
      config: builtinMemoryIndexConfig(),
    });
  };
  let memoryIndexInspectPromise = null;
  let memoryIndexInspectAt = 0;
  let memoryIndexInspectValue = null;
  const inspectBuiltinMemoryIndex = async () => {
    // Status is read-only and can be requested by three Settings cards at
    // once. Share the probe and keep a short snapshot so a transient SQLite
    // open/reindex cannot make the UI alternate between ready and error.
    const now = Date.now();
    if (memoryIndexInspectValue && now - memoryIndexInspectAt < 2_000) return memoryIndexInspectValue;
    if (!memoryIndexInspectPromise) {
      memoryIndexInspectPromise = inspectBuiltinMemoryIndexRaw();
      void memoryIndexInspectPromise.then((value) => {
        memoryIndexInspectValue = value;
        memoryIndexInspectAt = Date.now();
      }).catch(() => undefined).finally(() => {
        memoryIndexInspectPromise = null;
      });
    }
    return memoryIndexInspectPromise;
  };

  const extractStoredMessageText = (message) => {
    if (typeof message?.text === "string" && message.text.trim()) return message.text;
    if (typeof message?.content === "string" && message.content.trim()) return message.content;
    if (Array.isArray(message?.parts)) {
      // Prefer full part flatten when engine helper is unavailable; textFromTurnParts
      // keeps text-only, which is enough for most user/assistant rows.
      const textOnly = textFromTurnParts(message.parts);
      if (textOnly.trim()) return textOnly;
      // Fallback: include short tool breadcrumbs for searchability.
      return message.parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          if (part.type === "tool") {
            const name = typeof part.name === "string" ? part.name : "tool";
            const result = typeof part.result === "string" ? part.result.slice(0, 400) : "";
            return result ? `[tool:${name}] ${result}` : `[tool:${name}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  };

  /** Chat JSON store stays SoT; project a search-friendly corpus into the index. */
  const collectSessionsForMemoryIndex = () => {
    const sessions = Array.isArray(store.sessions) ? store.sessions : [];
    return sessions.map((session) => ({
      id: session.id,
      title: typeof session.title === "string" ? session.title : "",
      workspace: typeof config.workspace === "string" ? config.workspace : undefined,
      messages: store.getMessages(session.id).map((message) => ({
        id: message.id,
        role: message.role,
        text: extractStoredMessageText(message),
        at: message.at,
      })),
    }));
  };

  let sessionProjectTimer = null;
  let sessionProjectPending = new Set();
  const scheduleSessionMemoryProject = (sessionId) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) return;
    const indexCfg = builtinMemoryIndexConfig();
    if (!indexCfg.enabled || indexCfg.backend === "off") return;
    sessionProjectPending.add(sessionId);
    if (sessionProjectTimer) return;
    sessionProjectTimer = setTimeout(() => {
      sessionProjectTimer = null;
      const ids = [...sessionProjectPending];
      sessionProjectPending = new Set();
      void projectSessionsToMemoryIndex(ids).catch(() => undefined);
    }, 1_500);
    sessionProjectTimer.unref?.();
  };

  const projectSessionsToMemoryIndex = async (sessionIds) => {
    const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
    if (!workspace || !sessionIds?.length) return;
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return;
    }
    if (typeof mod?.openMemoryIndex !== "function" || typeof mod?.projectSessionsIntoMemory !== "function") return;
    const sessions = sessionIds
      .map((id) => {
        const session = store.getSession(id);
        if (!session) return null;
        return {
          id,
          title: typeof session.title === "string" ? session.title : "",
          workspace,
          messages: store.getMessages(id).map((message) => ({
            id: message.id,
            role: message.role,
            text: extractStoredMessageText(message),
            at: message.at,
          })),
        };
      })
      .filter(Boolean);
    if (!sessions.length) return;
    let index;
    try {
      index = await mod.openMemoryIndex(workspace, builtinMemoryIndexConfig());
      const stores = index?.stores;
      if (!stores) return;
      await mod.projectSessionsIntoMemory(sessions, {
        workspace,
        memory: stores.memory,
        vectors: stores.vectors,
        sensitiveValues: runtimeSensitiveValues(),
        pruneStale: true,
      });
    } catch {
      /* fail-open projection */
    } finally {
      try {
        await index?.stores?.close?.();
      } catch {
        /* ignore */
      }
    }
  };

  const reindexBuiltinMemoryIndex = async ({ refreshProjectIndex = false } = {}) => {
    const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
    if (!workspace) {
      return {
        ok: false,
        upserted: 0,
        vectorsUpserted: 0,
        sessionUpserted: 0,
        sources: [],
        status: await inspectBuiltinMemoryIndex(),
        error: "workspace_not_configured",
      };
    }
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return {
        ok: false,
        upserted: 0,
        vectorsUpserted: 0,
        sessionUpserted: 0,
        sources: [],
        status: await inspectBuiltinMemoryIndex(),
        error: "adapter_unavailable",
      };
    }
    if (typeof mod?.reindexWorkspaceMemoryIndex !== "function") {
      return {
        ok: false,
        upserted: 0,
        vectorsUpserted: 0,
        sessionUpserted: 0,
        sources: [],
        status: await inspectBuiltinMemoryIndex(),
        error: "adapter_unavailable",
      };
    }
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const memory = isPlainRecord(engine.memory) ? engine.memory : {};
    const planning = isPlainRecord(engine.planning) ? engine.planning : {};
    return mod.reindexWorkspaceMemoryIndex({
      workspace,
      config: builtinMemoryIndexConfig(),
      ltmEnabled: memory.ltm?.enabled !== false,
      planningEnabled: planning.enabled !== false,
      sessions: collectSessionsForMemoryIndex(),
      sensitiveValues: runtimeSensitiveValues(),
      ...(isPlainRecord(memory.vault) ? { vault: memory.vault } : {}),
      refreshProjectIndex,
    });
  };

  /**
   * OOB: create local SQLite + .kyrei layout when the user opens a project folder.
   * Awaited on workspace set so chat/memory work immediately — no manual Rebuild.
   * Fail-open on errors (still returns; never blocks open forever).
   */
  const bootstrapLocalDatabases = async (reason = "start") => {
    const result = {
      ok: true,
      reason,
      sessionMirror: false,
      workspace: false,
      reindexed: false,
      error: undefined,
    };
    try {
      // Session mirror DB under app dataDir (chat dual-write).
      const mirror = await ensureSessionMirror().catch(() => null);
      result.sessionMirror = Boolean(mirror);
      const mod = await getEngine();
      if (typeof mod?.bootstrapGatewayLocalStores === "function") {
        const gw = mod.bootstrapGatewayLocalStores(dataDir);
        result.sessionMirror = result.sessionMirror || gw.ok;
        if (!gw.ok) {
          console.warn("[kyrei bootstrap] session-mirror:", gw.sessionMirror?.error ?? "failed");
        }
      }
      const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
      if (workspace && typeof mod?.bootstrapWorkspaceLocalStores === "function") {
        const ws = await mod.bootstrapWorkspaceLocalStores({
          workspace,
          config: builtinMemoryIndexConfig(),
          seedMemoryMd: true,
        });
        result.workspace = Boolean(ws.ok);
        if (!ws.ok) {
          console.warn(
            `[kyrei bootstrap] workspace (${reason}):`,
            ws.index?.error || ws.graph?.error || "partial",
          );
        }
        // Always warm the projection after open-folder so index is not empty
        // and memory_search works without a Settings click.
        if (ws.index?.ok !== false) {
          try {
            const reindex = await reindexBuiltinMemoryIndex();
            result.reindexed = reindex?.ok === true;
          } catch {
            /* fail-open */
          }
        }
      }
      result.ok = result.sessionMirror || result.workspace;
    } catch (error) {
      result.ok = false;
      result.error = error?.message ?? String(error);
      console.warn("[kyrei bootstrap] skipped:", result.error);
    }
    return result;
  };

  /** Rebuild LTM runtime snapshot (active-context / last-recall) from the ledger. */
  const consolidateBuiltinLtm = async () => {
    const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
    if (!workspace) {
      return { ok: false, error: "workspace_not_configured" };
    }
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const memory = isPlainRecord(engine.memory) ? engine.memory : {};
    if (memory.ltm?.enabled === false) {
      return { ok: false, error: "ltm_disabled" };
    }
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return { ok: false, error: "adapter_unavailable" };
    }
    if (typeof mod?.consolidateLtm !== "function") {
      return { ok: false, error: "adapter_unavailable" };
    }
    try {
      const result = await mod.consolidateLtm(workspace);
      return {
        ok: Boolean(result?.success),
        via: result?.via,
        ...(result?.error ? { error: result.error } : {}),
        ...(result?.stdout ? { stdout: result.stdout } : {}),
      };
    } catch (error) {
      return { ok: false, error: error?.message ?? "consolidate_failed" };
    }
  };

  /**
   * Wave H UI: list / fetch / pin / supersede LTM decisions for Settings.
   * Ledger remains SoT under workspace/ltm/store/decisions.jsonl.
   */
  const withLtmBridge = async () => {
    const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
    if (!workspace) return { ok: false, error: "workspace_not_configured" };
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const memory = isPlainRecord(engine.memory) ? engine.memory : {};
    if (memory.ltm?.enabled === false) return { ok: false, error: "ltm_disabled" };
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return { ok: false, error: "adapter_unavailable" };
    }
    if (typeof mod?.createLtmBridge !== "function") {
      return { ok: false, error: "adapter_unavailable" };
    }
    const pathMod = await import("node:path");
    const ltmDir = pathMod.join(workspace, "ltm");
    const bridge = mod.createLtmBridge(ltmDir);
    return { ok: true, bridge, ltmDir, workspace };
  };

  const listLtmDecisionsApi = async (opts = {}) => {
    const ctx = await withLtmBridge();
    if (!ctx.ok) return ctx;
    try {
      const includeInvalidated = opts.includeInvalidated === true;
      const decisions = await ctx.bridge.listDecisions({
        includeInvalidated,
        rankByConfidence: true,
      });
      return {
        ok: true,
        count: decisions.length,
        decisions: decisions.map((d) => ({
          id: d.id,
          decision: d.decision,
          rationale: d.rationale,
          validFrom: d.validFrom,
          validTo: d.validTo,
          tags: d.tags,
          sessionId: d.sessionId,
          pinned: Boolean(d.pinned),
          kind: d.kind,
          confidence: d.confidence,
          supersedes: d.supersedes,
          lastAccessedAt: d.lastAccessedAt,
          active: d.validTo == null,
        })),
      };
    } catch (error) {
      return { ok: false, error: error?.message ?? "list_decisions_failed" };
    }
  };

  const fetchLtmDecisionApi = async (id) => {
    const ctx = await withLtmBridge();
    if (!ctx.ok) return ctx;
    if (typeof id !== "string" || !id.trim()) return { ok: false, error: "id_required" };
    try {
      const { decision, history } = await ctx.bridge.fetchDecision(id.trim());
      if (!decision) return { ok: false, error: "not_found" };
      const map = (d) => ({
        id: d.id,
        decision: d.decision,
        rationale: d.rationale,
        validFrom: d.validFrom,
        validTo: d.validTo,
        tags: d.tags,
        sessionId: d.sessionId,
        pinned: Boolean(d.pinned),
        kind: d.kind,
        confidence: d.confidence,
        supersedes: d.supersedes,
        lastAccessedAt: d.lastAccessedAt,
        active: d.validTo == null,
      });
      return { ok: true, decision: map(decision), history: history.map(map) };
    } catch (error) {
      return { ok: false, error: error?.message ?? "fetch_decision_failed" };
    }
  };

  /** Toggle pin in-place (stable id — no SUPERSEDE spam). */
  const pinLtmDecisionApi = async (id, pinned) => {
    const ctx = await withLtmBridge();
    if (!ctx.ok) return ctx;
    if (typeof id !== "string" || !id.trim()) return { ok: false, error: "id_required" };
    try {
      const { decision } = await ctx.bridge.fetchDecision(id.trim());
      if (!decision) return { ok: false, error: "not_found" };
      if (decision.validTo) return { ok: false, error: "decision_superseded" };
      const wantPinned = pinned === true;
      if (Boolean(decision.pinned) === wantPinned) {
        return { ok: true, id: decision.id, pinned: wantPinned, unchanged: true };
      }
      if (typeof ctx.bridge.setPinned !== "function") {
        return { ok: false, error: "adapter_unavailable" };
      }
      const ok = await ctx.bridge.setPinned(decision.id, wantPinned);
      if (!ok) return { ok: false, error: "decision_superseded" };
      try {
        await ctx.bridge.refreshRuntimeSnapshot();
      } catch {
        /* optional */
      }
      void reindexBuiltinMemoryIndex().catch(() => undefined);
      return { ok: true, id: decision.id, pinned: wantPinned };
    } catch (error) {
      return { ok: false, error: error?.message ?? "pin_decision_failed" };
    }
  };

  /**
   * Distill a session into notes / MEMORY / LTM / handoff (session-curator).
   * Fail-open: never blocks archive. Optional small LLM when provider ready.
   */
  const runSessionCurator = async (sessionId, opts = {}) => {
    const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
    if (!workspace) return { ok: false, error: "no_workspace", sessionId };
    const session = store.getSession(sessionId);
    if (!session) return { ok: false, error: "session_not_found", sessionId };
    const messages = store.getMessages(sessionId);
    const engine = isPlainRecord(config.engine) ? config.engine : {};
    const memory = isPlainRecord(engine.memory) ? engine.memory : {};
    const curatorCfg = isPlainRecord(memory.curator) ? memory.curator : {};
    let mod;
    try {
      mod = await getEngine();
    } catch {
      return { ok: false, error: "adapter_unavailable", sessionId };
    }
    if (typeof mod?.curateSession !== "function") {
      return { ok: false, error: "adapter_unavailable", sessionId };
    }
    let model;
    let modelSourceUsed = "none";
    if (curatorCfg.useLlm !== false && typeof mod.buildModel === "function") {
      try {
        const source = curatorCfg.modelSource === "session" || curatorCfg.modelSource === "default"
          ? curatorCfg.modelSource
          : "worker";
        /** @type {object | undefined} */
        let target;
        if (source === "worker") {
          target = workerRuntimeTarget(sessionId);
          if (target) modelSourceUsed = "worker";
        }
        if (!target && (source === "session" || source === "worker")) {
          try {
            const targets = privateRuntimeTargetsForConfig(
              config,
              secrets,
              session.providerId || config.activeProviderId,
              session.modelId || config.activeModelId,
              {
                fallbackToDefault: true,
                sessionId,
                preferredAccountId: session.providerAccountId,
              },
            );
            target = targets[0];
            if (target) modelSourceUsed = "session";
          } catch {
            target = undefined;
          }
        }
        if (!target) {
          try {
            const targets = privateRuntimeTargetsForConfig(
              config,
              secrets,
              config.activeProviderId,
              config.activeModelId,
              { fallbackToDefault: true, sessionId },
            );
            target = targets[0];
            if (target) modelSourceUsed = "default";
          } catch {
            target = undefined;
          }
        }
        if (target) {
          model = mod.buildModel({
            protocol: target.protocol,
            baseURL: target.baseURL,
            apiKey: typeof target.apiKey === "string" ? target.apiKey : "",
            credentials: target.credentials ?? {},
            model: target.model,
            ...(target.headers ? { headers: target.headers } : {}),
          });
        }
      } catch {
        model = undefined; // heuristic only
        modelSourceUsed = "none";
      }
    }
    try {
      const result = await mod.curateSession({
        sessionId,
        workspace,
        title: session.title,
        messages,
        config: curatorCfg,
        ...(model ? { model } : {}),
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        ...(opts.applyModeOverride ? { applyModeOverride: opts.applyModeOverride } : {}),
      });
      if (result?.applied?.length) {
        // Refresh FTS projection so memory_search sees new notes/MEMORY soon.
        void reindexBuiltinMemoryIndex().catch(() => undefined);
      }
      return { ...result, modelSource: modelSourceUsed };
    } catch (error) {
      return { ok: false, error: error?.message ?? "curate_failed", sessionId };
    }
  };

  /** Hard deadline for auto-archive curator so a stuck provider cannot hang the process forever. */
  const ARCHIVE_CURATOR_TIMEOUT_MS = 25_000;

  /**
   * Fire-and-forget curator after soft-archive. Never blocks the HTTP response.
   * Emits `session.curated` on success; fail-open on timeout/errors.
   */
  const scheduleArchiveCurator = (sessionId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, ARCHIVE_CURATOR_TIMEOUT_MS);
    void (async () => {
      try {
        const curator = await runSessionCurator(sessionId, { abortSignal: controller.signal });
        if (curator?.ok) {
          emitTo(sessionId, {
            type: "session.curated",
            payload: {
              session_id: sessionId,
              applied: curator.applied,
              via: curator.via,
              summary: curator.summary,
            },
          });
        }
      } catch {
        /* fail-open: archive already committed */
      } finally {
        clearTimeout(timer);
      }
    })();
  };

  /** Batch-curate many sessions (e.g. all archived). Sequential, fail-open per id. */
  const runSessionCuratorBatch = async ({ sessionIds, applyModeOverride } = {}) => {
    let ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === "string" && id) : [];
    if (!ids.length) {
      ids = store.listArchivedSessions().map((s) => s.id);
    }
    ids = ids.slice(0, 40);
    const results = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const r = await runSessionCurator(id, {
        ...(applyModeOverride ? { applyModeOverride } : {}),
      });
      results.push({
        sessionId: id,
        ok: r?.ok !== false,
        applied: r?.applied ?? [],
        via: r?.via,
        summary: r?.summary,
        error: r?.error,
        modelSource: r?.modelSource,
      });
    }
    return {
      ok: true,
      count: results.length,
      succeeded: results.filter((r) => r.ok).length,
      results,
    };
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

  function trackSessionActivity(sessionId, event) {
    const previous = runtimeActivity.get(sessionId);
    if (!previous && event?.type !== "message.start") return;
    const payload = event?.payload ?? {};
    const now = Date.now();
    const next = {
      ...(previous ?? {
        active: true,
        phase: "thinking",
        startedAt: now,
        eventCount: 0,
        toolCount: 0,
      }),
      updatedAt: now,
      eventCount: (previous?.eventCount ?? 0) + 1,
    };
    switch (event?.type) {
      case "message.start":
        next.messageId = typeof payload.message_id === "string" ? payload.message_id : previous?.messageId;
        break;
      case "reasoning.delta":
        next.phase = "reasoning";
        break;
      case "tool.start":
        next.phase = "tool";
        next.currentTool = typeof payload.name === "string" ? payload.name : undefined;
        next.toolCount = (previous?.toolCount ?? 0) + 1;
        break;
      case "tool.complete":
        next.phase = payload.error ? "recovering" : "reasoning";
        next.currentTool = undefined;
        break;
      case "approval.request":
        next.phase = "awaiting_approval";
        next.currentTool = typeof payload.name === "string" ? payload.name : undefined;
        break;
      case "approval.consumed":
        next.phase = "tool";
        break;
      case "message.delta":
        next.phase = "responding";
        next.currentTool = undefined;
        break;
      case "status.update": {
        const usage = payload.usage;
        if (usage && typeof usage === "object") {
          const total = Number(usage.totalTokens ?? 0) || (Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0));
          if (total > 0) next.tokens = total;
        }
        break;
      }
      case "message.complete":
        next.active = false;
        next.phase = payload.status === "interrupted"
          ? "interrupted"
          : payload.status === "error"
            ? "failed"
            : payload.status === "awaiting_approval"
              ? "awaiting_approval"
              : "complete";
        next.currentTool = undefined;
        next.completedAt = now;
        break;
      default:
        break;
    }
    runtimeActivity.set(sessionId, next);
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

  function publishPublicEvent(sessionId, publicEvent) {
    trackSessionActivity(sessionId, publicEvent);
    trackSubagentEvent(sessionId, publicEvent);
    const runId = publicEvent?.payload?.run_id;
    if (typeof runId === "string" && runId) {
      void teamRunStore.append(runId, publicEvent).catch(() => undefined);
    }
    writePublicEvent(sessionId, publicEvent);
  }

  function emitTo(sessionId, event) {
    const publicEvent = publicRuntimeEvent(event);
    publishPublicEvent(sessionId, publicEvent);
  }

  function updateActiveTurnDraft(turn, publicEvent) {
    if (!turn.acceptEvents) return;
    const nextParts = foldTurnDraftEvent(turn.parts, publicEvent);
    if (nextParts === turn.parts) return;
    turn.parts = nextParts;
    createActiveTurnDraft(turn);
    store.updateMessage(turn.sessionId, turn.draftId, {
      content: textFromTurnParts(nextParts),
      parts: nextParts,
      pending: true,
      turnStatus: "streaming",
    });
  }

  function emitActiveTurnEvent(turn, event) {
    if (!turn.acceptEvents) return;
    const publicEvent = publicRuntimeEvent(event);
    if (publicEvent?.type === "error") {
      const payload = publicEvent.payload ?? {};
      turn.errorCode = typeof payload.code === "string" ? payload.code : undefined;
      turn.errorMessage = typeof payload.message === "string" ? payload.message : undefined;
    }
    updateActiveTurnDraft(turn, publicEvent);
    if (publicEvent?.type === "message.complete") {
      turn.terminalEvent = publicEvent;
      return;
    }
    publishPublicEvent(turn.sessionId, publicEvent);
  }

  function createActiveTurnDraft(turn) {
    if (turn.draftId) {
      const existing = store.getMessage(turn.sessionId, turn.draftId);
      if (existing) return existing;
    }
    const draft = store.appendMessage(turn.sessionId, {
      id: turn.draftId || undefined,
      role: "assistant",
      content: "",
      parts: [],
      pending: true,
      turnStatus: "streaming",
    });
    turn.draftId = draft.id;
    return draft;
  }

  function finalizeActiveTurn(turn, {
    status,
    text,
    parts,
    modelMessages,
    approvalModelParams,
    fileReview,
  } = {}) {
    if (turn.finalizePromise) return turn.finalizePromise;
    turn.acceptEvents = false;
    turn.finalized = true;
    const terminalStatus = typeof status === "string" && status ? status : "error";
    const operation = (async () => {
      // Some providers expose their whole answer exclusively through SSE and
      // return an empty aggregate result. Never let that empty aggregate erase
      // a durable streamed draft at the terminal boundary.
      const draftParts = mergeTerminalTurnParts(turn.parts, parts);
      let finalParts = terminalStatus === "interrupted"
        ? interruptedTurnParts(draftParts)
        : draftParts;
      let finalText = typeof text === "string" && text
        ? text
        : textFromTurnParts(finalParts);
      const terminalPayload = turn.terminalEvent?.payload ?? {};
      const terminalText = typeof terminalPayload.text === "string" ? terminalPayload.text : "";
      if (!finalText && terminalText) {
        finalText = terminalText;
        finalParts = appendTurnStreamPart(finalParts, "text", terminalText);
      }
      if (finalText || meaningfulTurnParts(finalParts) || terminalStatus === "awaiting_approval") {
        createActiveTurnDraft(turn);
        if (turn.draftId) {
          store.updateMessage(turn.sessionId, turn.draftId, {
            content: finalText,
            parts: finalParts,
            pending: false,
            turnStatus: terminalStatus,
            ...(Array.isArray(modelMessages) && modelMessages.length ? { modelMessages } : {}),
            ...(approvalModelParams ? { approvalModelParams } : {}),
            ...(fileReview && typeof fileReview === "object" ? { fileReview } : {}),
            ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
            ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
          });
        }
      } else if (turn.draftId && store.getMessage(turn.sessionId, turn.draftId)) {
        store.removeMessage(turn.sessionId, turn.draftId);
      }
      // A normal terminal SSE frame is a durability acknowledgement: when the
      // renderer sees it, the exact assistant turn is already restart-safe.
      // Disk failures are surfaced as a separate, explicit non-durable error
      // so the turn is released instead of permanently blocking the session.
      try {
        await store.flush();
      } catch {
        turn.persistenceFailed = true;
        if (!turn.terminalPublished) {
          turn.terminalPublished = true;
          publishPublicEvent(turn.sessionId, {
            type: "error",
            payload: { code: "session_persistence_failed" },
          });
          publishPublicEvent(turn.sessionId, {
            type: "message.complete",
            payload: { text: finalText, status: "error", durable: false },
          });
        }
        return store.getMessage(turn.sessionId, turn.draftId);
      }
      // A4c: dual-commit engine after JSON flush (strict when enginePrimary).
      const engineCommit = await commitSessionToEngine(turn.sessionId);
      if (!engineCommit.ok && sessionMirrorEnginePrimary()) {
        turn.persistenceFailed = true;
        if (!turn.terminalPublished) {
          turn.terminalPublished = true;
          publishPublicEvent(turn.sessionId, {
            type: "error",
            payload: {
              code: "engine_mirror_write_failed",
              message: engineCommit.error ?? "engine_mirror_write_failed",
            },
          });
          publishPublicEvent(turn.sessionId, {
            type: "message.complete",
            payload: { text: finalText, status: "error", durable: false },
          });
        }
        return store.getMessage(turn.sessionId, turn.draftId);
      }
      if (!turn.terminalPublished) {
        turn.terminalPublished = true;
        publishPublicEvent(turn.sessionId, {
          type: "message.complete",
          payload: { ...terminalPayload, text: finalText, status: terminalStatus },
        });
      }
      return store.getMessage(turn.sessionId, turn.draftId);
    })();
    turn.finalizePromise = operation;
    return operation;
  }

  function releaseActiveTurn(turn) {
    turn.shutdownSignal?.removeEventListener("abort", turn.abortForShutdown);
    if (activeTurns.get(turn.sessionId) !== turn) return;
    activeTurns.delete(turn.sessionId);
    if (controllers.get(turn.sessionId) === turn.controller) controllers.delete(turn.sessionId);
    // A force-finalized non-cooperative provider must not keep the session
    // reservation forever. The late promise is fenced by `acceptEvents` and
    // can no longer mutate history or become the owner of a new turn.
    sessionReservations.delete(turn.sessionId);
    activePromptProviders.delete(turn.sessionId);
    runtimeStatus.delete(turn.sessionId);
    const now = Date.now();
    for (const [id, run] of subagentRuns) {
      if (run.sessionId !== turn.sessionId || (run.status !== "queued" && run.status !== "running")) continue;
      subagentRuns.set(id, {
        ...run,
        status: "interrupted",
        updatedAt: now,
        error: run.error ?? "turn_interrupted",
      });
    }
    const activity = runtimeActivity.get(turn.sessionId);
    if (activity?.active) {
      runtimeActivity.set(turn.sessionId, {
        ...activity,
        active: false,
        phase: turn.controller.signal.aborted ? "interrupted" : "failed",
        currentTool: undefined,
        updatedAt: now,
        completedAt: now,
      });
    }
  }

  function beginActiveTurn(sessionId) {
    const controller = new AbortController();
    const turn = {
      sessionId,
      controller,
      completion: null,
      // The renderer needs a stable id as soon as the turn starts, while a
      // durable assistant entry should be created only after real output.
      // This avoids persisting a misleading blank assistant message for a
      // provider that has not emitted anything yet.
      draftId: `msg-${randomBytes(16).toString("base64url")}`,
      parts: [],
      errorCode: undefined,
      errorMessage: undefined,
      persistenceFailed: false,
      terminalEvent: null,
      terminalPublished: false,
      acceptEvents: true,
      finalized: false,
      finalizePromise: null,
      shutdownSignal: shutdownController.signal,
      abortForShutdown: null,
    };
    turn.abortForShutdown = () => {
      if (!controller.signal.aborted) controller.abort(new Error("gateway-shutdown"));
    };
    shutdownController.signal.addEventListener("abort", turn.abortForShutdown, { once: true });
    if (shutdownController.signal.aborted) turn.abortForShutdown();
    activeTurns.set(sessionId, turn);
    controllers.set(sessionId, controller);
    runtimeStatus.set(sessionId, "working");
    runtimeActivity.set(sessionId, {
      active: true,
      phase: "thinking",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      eventCount: 0,
      toolCount: 0,
    });
    return turn;
  }

  function ownsActiveTurn(turn) {
    return activeTurns.get(turn.sessionId) === turn
      && !turn.controller.signal.aborted
      && !shutdownController.signal.aborted;
  }

  function assertTurnOwnsSessionMutation(turn) {
    if (ownsActiveTurn(turn)) return;
    // An engine transport may ignore AbortSignal and invoke a callback after
    // its turn was force-finalized.  SessionStore intentionally remains an
    // in-memory object after close(), so this guard must live at the callback
    // boundary rather than relying on store.close() to reject the mutation.
    if (shutdownController.signal.aborted) throw gatewayShutdownError();
    const error = new Error("turn_interrupted");
    error.code = "turn_interrupted";
    throw error;
  }

  function waitForActiveTurn(turn) {
    if (!turn?.completion) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), turnSettleTimeoutMs);
      Promise.resolve(turn.completion).then(() => finish(true), () => finish(true));
    });
  }

  async function cancelActiveTurn(turn, reason = "operation-aborted") {
    if (!turn) return null;
    if (!turn.controller.signal.aborted) turn.controller.abort(new Error(reason));
    const settled = await waitForActiveTurn(turn);
    if (!settled) {
      await finalizeActiveTurn(turn, { status: "interrupted" });
      releaseActiveTurn(turn);
    } else if (turn.finalizePromise) {
      await turn.finalizePromise;
    }
    return store.getMessage(turn.sessionId, turn.draftId)?.id || null;
  }

  // The assistant record becomes visible in memory immediately before the
  // atomic flush completes. A user can legitimately submit the next prompt in
  // that narrow interval. Drain only an already-finalizing turn instead of
  // replying `session_busy`; a still-running provider remains exclusive.
  async function releaseFinalizedTurn(sessionId) {
    const turn = activeTurns.get(sessionId);
    if (!turn?.finalized) return false;
    await turn.finalizePromise?.catch(() => undefined);
    releaseActiveTurn(turn);
    return true;
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

  function accountPoolRouterFor(provider, secretState = secrets, configState = config) {
    const pool = normalizeProviderAccountPool(provider.accountPool, provider.models);
    const readyIds = new Set(readyProviderAccounts(provider, secretState, configState).map((account) => account.id));
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
            // Enum only — never raw provider bodies (anti-false-ban + no secret leak).
            failureClass: outcome.failureClass,
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
    const limits = privateRuntimeModelLimits(model);
    return ordered.map((account) => {
      let credentials = provider.requiresApiKey
        ? getProviderAccountCredentials(secretState, provider.id, account.id)
        : {};
      if (provider.credentialSource === "browser-subscription") {
        const resolved = resolveBrowserSubscriptionCredentials(configState, secretState, provider);
        if (!resolved?.apiKey) throw new ProviderConfigError("provider_credentials_required");
        credentials = { apiKey: resolved.apiKey };
      }
      return {
        providerId: provider.id,
        ...(poolEnabled ? { accountId: account.id } : {}),
        protocol: provider.protocol,
        baseURL: provider.baseURL,
        model: model.id,
        apiKey: provider.requiresApiKey || provider.credentialSource === "browser-subscription"
          ? credentials.apiKey ?? ""
          : "",
        credentials,
        ...(provider.headers ? { headers: provider.headers } : {}),
        requiresApiKey: provider.requiresApiKey || provider.credentialSource === "browser-subscription",
        ...(limits ? { limits: { ...limits } } : {}),
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

  /**
   * Wave G2: resolve modelAssignments role (plan/build/polish/deepreep) for the
   * session coding mode. Fail-open to undefined → keep session model.
   * @param {"plan"|"build"|"polish"|"deepreep"} role
   * @param {string} [sessionId]
   */
  function roleAssignmentRuntimeTarget(role, sessionId) {
    const ref = config.modelAssignments?.[role];
    if (!ref || typeof ref.providerId !== "string" || typeof ref.modelId !== "string") {
      return undefined;
    }
    try {
      return privateRuntimeTargetForConfig(config, secrets, ref.providerId, ref.modelId, {
        routingKey: sessionId ? `${sessionId}:role:${role}` : `role:${role}`,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Map session codingMode → assignment role. Auto has no forced role switch.
   * @param {string|undefined} codingMode
   * @returns {"plan"|"build"|"polish"|"deepreep"|null}
   */
  function codingModeToAssignmentRole(codingMode) {
    if (codingMode === "plan" || codingMode === "build" || codingMode === "polish" || codingMode === "deepreep") {
      return codingMode;
    }
    return null;
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
      ...(target.limits ? { limits: { ...target.limits } } : {}),
    };
  }

  function enabledTeamProfileForId(profileId, configState = config) {
    if (typeof profileId !== "string" || !profileId) return undefined;
    return configState.orchestration?.profiles?.find(
      (candidate) => candidate.id === profileId && candidate.enabled,
    );
  }

  /**
   * Team roles opt into skills explicitly. Do not let the ordinary chat
   * default (32 skills) decide which selected role skills make it to the
   * runtime; the profile is validated against this same aggregate cap.
   */
  function runtimeSkillsForTeamProfile(profile) {
    return skillsStore.runtimeSkills({
      ids: teamProfileSkillIds(profile),
      maxSkills: MAX_TEAM_PROFILE_SKILLS,
      strictRequested: true,
    });
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
    const profile = enabledTeamProfileForId(profileId, configState);
    if (!profile) return undefined;
    const availableSkills = new Set(
      (Array.isArray(runtimeSkills) ? runtimeSkills : [])
        .map((skill) => typeof skill?.id === "string" ? skill.id : "")
        .filter(Boolean),
    );
    const availablePromptProfiles = promptProfileIdsForEngine(configState.engine);
    if (profile.roles.some((role) => (
      role.skillIds.some((id) => !availableSkills.has(id))
      || (role.promptProfileId && !availablePromptProfiles.has(role.promptProfileId))
    ))) return undefined;
    try {
      const roles = profile.roles.map((role) => ({
        id: role.id,
        name: role.name,
        ...(role.description ? { description: role.description } : {}),
        ...(role.instructions ? { instructions: role.instructions } : {}),
        ...(role.promptProfileId ? { promptProfileId: role.promptProfileId } : {}),
        target: role.model
          ? privateRuntimeTargetForConfig(
              configState,
              secretState,
              role.model.providerId,
              role.model.modelId,
              { routingKey: `${routingKeyPrefix}:${profile.id}:${role.id}` },
            )
          : cloneRuntimeTarget(mainTarget),
        skillIds: [...role.skillIds],
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

  const MAX_APPLICABLE_PATCH_BYTES = 64 * 1_024;

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
      && isPipelineTextList(value.whatWasNotChecked, 48, 1_000)
      && (
        value.clarificationRequests === undefined
        || (
          Array.isArray(value.clarificationRequests)
          && value.clarificationRequests.length <= 8
          && value.clarificationRequests.every((request) => (
            request
            && typeof request === "object"
            && !Array.isArray(request)
            && isPipelineText(request.id, 120)
            && isPipelineText(request.question, 2_000)
            && typeof request.context === "string"
            && request.context.length <= 4_000
            && (request.options === undefined || (
              Array.isArray(request.options)
              && request.options.length <= 8
              && request.options.every((option) => (
                option
                && typeof option === "object"
                && !Array.isArray(option)
                && isPipelineText(option.id, 80)
                && isPipelineText(option.label, 300)
                && (option.impact === undefined || isPipelineText(option.impact, 600))
              ))
            ))
            && (request.recommended === undefined || isPipelineText(request.recommended, 80))
            && typeof request.blocking === "boolean"
          ))
        )
      )
      && (
        value.applicablePatch === undefined
        || (
          typeof value.applicablePatch === "string"
          && value.applicablePatch.length > 0
          && Buffer.byteLength(value.applicablePatch, "utf8") <= MAX_APPLICABLE_PATCH_BYTES
        )
      );
  }

  /**
   * Map team applicablePatch → PatchEvidenceRef without pipelineText collapse
   * (multi-line patch format must be preserved).
   */
  function buildApplicablePatchEvidence(applicablePatch, { capturedAt, workspaceDigest, sensitiveValues }) {
    if (typeof applicablePatch !== "string" || applicablePatch.length === 0) {
      throw new Error("pipeline_department_patch_invalid");
    }
    if (Buffer.byteLength(applicablePatch, "utf8") > MAX_APPLICABLE_PATCH_BYTES) {
      throw new Error("pipeline_artifact_patch_too_large");
    }
    if (redactSensitiveText(applicablePatch, sensitiveValues) !== applicablePatch) {
      throw new Error("pipeline_artifact_sensitive_value");
    }
    if (!/\*\*\* (Add|Update|Delete|Move) File: /.test(applicablePatch)) {
      throw new Error("pipeline_department_patch_invalid");
    }
    // Absolute paths / parent escapes — full parse happens in engine createArtifactEnvelope.
    const pathMatches = applicablePatch.matchAll(
      /\*\*\* (?:Add|Update|Delete|Move) File: ([^\n\r]+)/g,
    );
    for (const match of pathMatches) {
      const path = String(match[1] ?? "").trim().replace(/\\/g, "/");
      const destSplit = path.includes(" -> ") ? path.split(" -> ") : [path];
      for (const part of destSplit) {
        const normalized = part.trim();
        if (
          !normalized
          || normalized.startsWith("/")
          || /^[a-zA-Z]:\//.test(normalized)
          || normalized.split("/").some((segment) => segment === ".." || segment === "")
        ) {
          throw new Error("pipeline_department_patch_invalid");
        }
      }
    }
    const patchDigest = createHash("sha256").update(applicablePatch, "utf8").digest("hex");
    return {
      id: "applicable-patch",
      kind: "patch",
      origin: "reported",
      summary: "Applicable implementation patch",
      capturedAt,
      ...(typeof workspaceDigest === "string" && workspaceDigest
        ? { workspaceDigest }
        : {}),
      patch: applicablePatch,
      patchDigest,
    };
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
    const comparison = result?.comparison
      && typeof result.comparison === "object"
      && !Array.isArray(result.comparison)
      ? result.comparison
      : undefined;
    const comparisonClaims = Array.isArray(comparison?.claims)
      ? comparison.claims.slice(0, 256)
      : [];
    const comparisonClaimIds = new Map();
    for (const [index, claim] of comparisonClaims.entries()) {
      const statement = pipelineText(claim?.summary, 2_400, sensitiveValues);
      if (!statement) continue;
      const evidenceId = `comparison-evidence-${index + 1}`;
      const claimId = `comparison-claim-${index + 1}`;
      comparisonClaimIds.set(typeof claim?.id === "string" ? claim.id : "", claimId);
      evidence.push({
        id: evidenceId,
        kind: "diagnostic",
        origin: "reported",
        summary: `comparison claim: ${statement}`,
        capturedAt,
        tool: "team-comparison",
        outputDigest: digestJson({
          taskId: pipelineText(claim?.taskId, 160, sensitiveValues),
          summary: statement,
          confidence: Number.isFinite(claim?.confidence) ? claim.confidence : 0,
        }),
      });
    }
    const claims = comparisonClaims.flatMap((claim, index) => {
      const statement = pipelineText(claim?.summary, 2_400, sensitiveValues);
      const claimId = `comparison-claim-${index + 1}`;
      return statement && comparisonClaimIds.has(typeof claim?.id === "string" ? claim.id : "")
        ? [{ id: claimId, statement, evidenceIds: [`comparison-evidence-${index + 1}`] }]
        : [];
    });
    const contradictions = Array.isArray(comparison?.conflicts)
      ? comparison.conflicts.slice(0, 16).flatMap((conflict, index) => {
          const claimIds = Array.isArray(conflict?.claimIds)
            ? conflict.claimIds.flatMap((id) => {
                const mapped = comparisonClaimIds.get(typeof id === "string" ? id : "");
                return mapped ? [mapped] : [];
              })
            : [];
          const summary = pipelineText(conflict?.summary, 2_400, sensitiveValues);
          return claimIds.length >= 2 && summary
            ? [{ id: `comparison-conflict-${index + 1}`, claimIds: [...new Set(claimIds)], summary, resolved: false }]
            : [];
        })
      : [];
    const clarificationRequests = [];
    const clarificationQuestions = new Set();
    const rawClarifications = [
      ...(Array.isArray(source.clarificationRequests) ? source.clarificationRequests : []),
      ...(Array.isArray(comparison?.clarificationRequests) ? comparison.clarificationRequests : []),
    ];
    for (const [index, request] of rawClarifications.slice(0, 16).entries()) {
      const question = pipelineText(request?.question, 2_000, sensitiveValues);
      if (!question) continue;
      const key = question.toLowerCase();
      if (clarificationQuestions.has(key)) continue;
      clarificationQuestions.add(key);
      const options = Array.isArray(request?.options)
        ? request.options.slice(0, 8).flatMap((option) => {
            const label = pipelineText(option?.label, 300, sensitiveValues);
            return label ? [label] : [];
          })
        : [];
      clarificationRequests.push({
        id: `team-clarification-${index + 1}`,
        question,
        context: pipelineText(request?.context, 4_000, sensitiveValues) || "No additional context provided.",
        ...(options.length ? { options } : {}),
        ...(typeof request?.recommended === "string" && request.recommended.trim()
          ? { recommended: pipelineText(request.recommended, 80, sensitiveValues) }
          : {}),
        blocking: request?.blocking === true,
      });
    }
    if (source.applicablePatch !== undefined) {
      evidence.push(buildApplicablePatchEvidence(source.applicablePatch, {
        capturedAt,
        workspaceDigest: run.workspaceCheckpointDigest,
        sensitiveValues,
      }));
    }
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
      claims,
      evidence,
      checks: [],
      contradictions,
      ...(clarificationRequests.length ? { clarifications: clarificationRequests } : {}),
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
          : ["global", "project", "custom", "kiro"].includes(skill.provenance)
            ? skill.provenance
            : "custom",
        content: typeof skill.content === "string" ? skill.content : "",
        documents: (Array.isArray(skill.documents) ? skill.documents : []).flatMap((document) => {
          if (!document || typeof document.id !== "string") return [];
          return [{
            id: document.id.slice(0, 200),
            label: typeof document.label === "string" ? document.label.slice(0, 200) : "Document",
            relativePath: typeof document.relativePath === "string" ? document.relativePath.slice(0, 1_000) : "",
            source: document.source === "kiro-docs" ? "kiro-docs" : "skill",
            ...(typeof document.parentId === "string" ? { parentId: document.parentId.slice(0, 200) } : {}),
          }];
        }),
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
      const profile = enabledTeamProfileForId(stage.teamProfileId, configSnapshot);
      if (!profile) throw new Error("pipeline_department_team_unavailable");
      const runtimeSkills = await runtimeSkillsForTeamProfile(profile);
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
      const stageCodingMode = typeof mod.codingModeForPipelineStage === "function"
        ? mod.codingModeForPipelineStage({ id: stage.id, name: stage.name, kind: stage.kind })
        : undefined;
      const result = await mod.runTeamDepartment({
        team,
        goal: run.goal,
        stageId: stage.id,
        workspace: run.workspace,
        auditLogPath: join(dataDir, "audit.jsonl"),
        sessionId: pipelineSessionId,
        config: {
          ...(isPlainRecord(configSnapshot.engine) ? configSnapshot.engine : {}),
          ...(stageCodingMode ? { codingMode: stageCodingMode } : {}),
        },
        skills: runtimeSkillsForEngine(runtimeSkills.skills),
        readSkillDocument: (skillId, documentId) => skillsStore.readRuntimeDocument(skillId, documentId),
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

  async function executePipelineAction({ run, stage, dependencyArtifacts, signal, lease }) {
    const sensitiveValues = runtimeSensitiveValues();
    const startedAt = Date.now();
    try {
      await Promise.all([
        assertPipelineRuntimeCurrent(run),
        assertWorkspaceCheckpointCurrent(run),
      ]);
      throwIfAborted(signal ?? new AbortController().signal);
      const mod = await getEngine();
      if (typeof mod?.executeWorkspaceApply !== "function") {
        throw new Error("action_executor_unavailable");
      }
      const { observeWorkspace } = await import("./workspace-evidence.js");
      const outcome = await mod.executeWorkspaceApply({
        run,
        stage,
        dependencyArtifacts,
        signal,
        lease,
      }, { observeWorkspace });
      throwIfAborted(signal ?? new AbortController().signal);
      // Apply intentionally mutates the workspace; do not require the pre-apply
      // checkpoint to still match. Runtime pin still must be unchanged.
      await assertPipelineRuntimeCurrent(run);
      return outcome;
    } catch (error) {
      throw sanitizePipelineError(error, sensitiveValues, startedAt);
    }
  }

  async function executePipelineTruthGate({ run, stage, dependencyArtifacts, actionReceiptDigests, signal }) {
    const sensitiveValues = runtimeSensitiveValues();
    const startedAt = Date.now();
    try {
      await Promise.all([
        assertPipelineRuntimeCurrent(run),
        assertWorkspaceCheckpointCurrent(run),
      ]);
      throwIfAborted(signal ?? new AbortController().signal);
      const mod = await getEngine();
      if (typeof mod?.verifyPipelineTruthGate !== "function") {
        throw new Error("truth_gate_verifier_unavailable");
      }
      const { observeWorkspace } = await import("./workspace-evidence.js");
      // Prefer sandboxed trusted runner (mirrors run_command isolation). Falls open when
      // the host has no sandbox primitive (Windows) or engine export is missing.
      const sandboxMode = config.engine?.sandbox ?? "off";
      const sandbox = typeof mod.createSandbox === "function"
        ? mod.createSandbox(sandboxMode)
        : null;
      const runCommand = sandbox && typeof mod.createSandboxedTrustedCommandRunner === "function"
        ? mod.createSandboxedTrustedCommandRunner(sandbox, {
          allowNetwork: false,
          required: sandboxMode === "strict-required",
        })
        : undefined;
      const outcome = await mod.verifyPipelineTruthGate({
        run,
        stage,
        dependencyArtifacts,
        actionReceiptDigests,
        signal,
      }, {
        observeWorkspace,
        ...(runCommand ? { runCommand } : {}),
      });
      throwIfAborted(signal ?? new AbortController().signal);
      await Promise.all([
        assertPipelineRuntimeCurrent(run),
        assertWorkspaceCheckpointCurrent(run),
      ]);
      return { truthGateReceipt: outcome.truthGateReceipt };
    } catch (error) {
      throw sanitizePipelineError(error, sensitiveValues, startedAt);
    }
  }

  function authorizeActionReceipt(receipt) {
    if (!receipt || typeof receipt !== "object") throw new Error("pipeline_action_receipt_invalid");
    actionReceiptRegistry.add(receipt);
    return receipt;
  }

  function authorizeTruthGateReceipt(receipt) {
    if (!receipt || typeof receipt !== "object") throw new Error("pipeline_truth_gate_receipt_invalid");
    truthGateReceiptRegistry.add(receipt);
    return receipt;
  }

  const pipelineAdvances = new Map();
  const pipelineAdvanceControllers = new Map();
  const pipelineMissionRunner = new PipelineMissionRunner({
    runStore: pipelineRunStore,
    workspaceLeaseStore,
    executeDepartment: executePipelineDepartment,
    executeAction: executePipelineAction,
    verifyTruthGate: executePipelineTruthGate,
    authorizeActionReceipt,
    authorizeTruthGateReceipt,
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

  function attachmentsRoot() {
    return attachmentDirFor(dataDir);
  }

  async function resolveImagePresentation(sessionId) {
    const engineCfg = engineConfigForSession(sessionId);
    const mode = engineCfg?.imageInputMode ?? "auto";
    const session = store.getSession(sessionId);
    const providerId = session?.providerId || config.activeProviderId;
    const modelId = session?.modelId || config.activeModelId;
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const provider = providers.find((p) => p && p.id === providerId);
    const models = Array.isArray(provider?.models) ? provider.models : [];
    let model = models.find((m) => m && (m.id === modelId || m.name === modelId)) ?? null;
    if (!model && modelId) model = { id: modelId };
    let supports = false;
    try {
      const mod = await getEngine();
      if (typeof mod.modelSupportsImageInput === "function") {
        supports = mod.modelSupportsImageInput(model) === true;
      }
    } catch {
      supports = false;
    }
    try {
      const mod = await getEngine();
      if (typeof mod.decideImagePresentation === "function") {
        return mod.decideImagePresentation(mode, supports);
      }
    } catch {
      /* fall through */
    }
    if (mode === "native") return "native";
    if (mode === "text") return "text";
    return supports ? "native" : "text";
  }

  async function convoFor(sessionId) {
    const root = attachmentsRoot();
    const out = [];
    for (const message of store.getMessages(sessionId)) {
      if (message.role === "user") {
        const content = await userContentFromStoredMessage(message, root);
        out.push({ role: "user", content });
        continue;
      }
      if (message.role !== "assistant") continue;
      // The durable draft is a crash-recovery artifact for the current turn,
      // never prior model context. Feeding it back would duplicate the live
      // answer and may expose an unfinished tool call to the provider.
      if (message.pending === true || message.turnStatus === "streaming") continue;
      const structured = internalModelMessages(message.modelMessages);
      const history = structured.length
        ? structured
        : [{ role: "assistant", content: message.content }];
      const responses = approvalResponses(message.parts);
      if (responses.length) out.push(...history, { role: "tool", content: responses });
      else out.push(...history);
    }
    return out;
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

  /**
   * OOB heal: after a ready default appears, re-point idle chats that still
   * snapshotted the unready stub so the model picker and next prompt agree.
   * Skips in-flight turns (controllers) so a live run is not mid-swapped.
   */
  function rebindUnreadyIdleSessions(configState, secretState) {
    if (!isActiveProviderReady(configState, secretState)) return;
    const activeProviderId = configState.activeProviderId;
    const activeModelId = configState.activeModelId;
    for (const session of store.sessions) {
      if (!session?.id || session.archived === true) continue;
      if (controllers.has(session.id)) continue;
      if (session.providerId === activeProviderId && session.modelId === activeModelId) continue;
      try {
        requireReadyProviderModel(configState, secretState, session.providerId, session.modelId);
        continue;
      } catch {
        /* rebind unready snapshot */
      }
      store.upsertSession({
        id: session.id,
        providerId: activeProviderId,
        modelId: activeModelId,
        providerAccountId: undefined,
        updatedAt: new Date().toISOString(),
      });
      emitTo(session.id, {
        type: "session.model",
        payload: {
          session_id: session.id,
          provider_id: activeProviderId,
          model_id: activeModelId,
        },
      });
    }
  }

  async function runPrompt(sessionId, text, modelParams, messageId, reservationToken, options = {}) {
    const token = reservationToken ?? Symbol("prompt");
    const existingReservation = sessionReservations.get(sessionId);
    if (controllers.has(sessionId) || (existingReservation && existingReservation !== token)) {
      return { status: "error", sessionId, error: "session_busy" };
    }
    sessionReservations.set(sessionId, token);
    try {
      return await runReservedPrompt(sessionId, text, modelParams, messageId, options);
    } finally {
      if (sessionReservations.get(sessionId) === token) sessionReservations.delete(sessionId);
    }
  }

  function runReservedPrompt(sessionId, text, modelParams, messageId, options = {}) {
    const completion = executeReservedPrompt(sessionId, text, modelParams, messageId, options);
    // executeReservedPrompt registers the turn synchronously before its first
    // await, closing the prompt-response -> controller-registration race.
    const turn = activeTurns.get(sessionId);
    if (turn && !turn.completion) turn.completion = completion;
    return completion;
  }

  function hasPendingFileReview(sessionId) {
    return store.getMessages(sessionId).some((message) => (
      message?.fileReview?.status === "pending"
      || message?.fileReview?.status === "partial"
      || message?.turnStatus === "awaiting_file_review"
    ));
  }

  async function executeReservedPrompt(sessionId, text, modelParams, messageId, {
    appendUser = true,
    skillIds,
    images,
    accessPrincipal = null,
  } = {}) {
    if (shutdownController.signal.aborted) {
      return { status: "cancelled", sessionId, error: "gateway-shutdown" };
    }
    const session = store.getSession(sessionId);
    if (!session) return { status: "error", sessionId, error: "session-not-found" };
    if (controllers.has(sessionId)) return { status: "error", sessionId, error: "session_busy" };
    // Supervised mode: block until user accepts/rejects pending file edits.
    if (hasPendingFileReview(sessionId)) {
      return { status: "error", sessionId, error: "file_review_pending" };
    }

    const turn = beginActiveTurn(sessionId);
    const { controller } = turn;

    const safeModelParams = normalizedModelParams(modelParams);
    const runtimeGenerationSnapshot = new Map(
      config.providers.map((provider) => [provider.id, providerRuntimeGeneration(provider.id)]),
    );

    // Normalize images early so a bad payload fails before we open a turn stream.
    const { images: parsedImages, errors: imageErrors } = normalizePromptImages(images);
    if (imageErrors.length && !parsedImages.length && Array.isArray(images) && images.length) {
      // Turn already started — mark it failed so the session is not left streaming.
      try {
        await finalizeActiveTurn(turn, {
          status: "error",
          text: "",
          parts: [{ type: "text", text: `image_input_invalid: ${imageErrors[0]}` }],
        });
      } catch {
        controllers.delete(sessionId);
        activeTurns.delete(sessionId);
      }
      return { status: "error", sessionId, error: imageErrors[0] || "image_input_invalid" };
    }

    let storedUser = null;
    if (appendUser) {
      const safePromptText = redactSensitiveText(text, runtimeSensitiveValues());
      let imageAttachments = [];
      let imagePresentation = "text";
      if (parsedImages.length) {
        imagePresentation = await resolveImagePresentation(sessionId);
        try {
          imageAttachments = await persistPromptImages(attachmentsRoot(), sessionId, parsedImages);
        } catch (error) {
          try {
            await finalizeActiveTurn(turn, {
              status: "error",
              text: "",
              parts: [{ type: "text", text: `image_persist_failed: ${error?.message ?? error}` }],
            });
          } catch {
            controllers.delete(sessionId);
            activeTurns.delete(sessionId);
          }
          return { status: "error", sessionId, error: "image_persist_failed" };
        }
      }
      // Keep content as user text only; imageAttachments drive model + UI labels.
      storedUser = store.appendMessage(sessionId, {
        id: messageId,
        role: "user",
        content: safePromptText,
        ...(imageAttachments.length
          ? {
              imageAttachments,
              imagePresentation,
            }
          : {}),
      });
      if (!session.title) {
        const displayExtra = imageAttachmentDisplayText(imageAttachments);
        const titleBase = safePromptText || displayExtra || "image";
        store.upsertSession({
          id: sessionId,
          title: titleBase.slice(0, 48) + (titleBase.length > 48 ? "…" : ""),
          updatedAt: new Date().toISOString(),
        });
        emitTo(sessionId, { type: "session.title", payload: { session_id: sessionId, title: store.getSession(sessionId).title } });
      }
      // A4c: dual-commit user append early when enginePrimary (crash safety).
      if (sessionMirrorEnginePrimary()) {
        const userCommit = await commitSessionToEngine(sessionId);
        if (!userCommit.ok) {
          console.warn("[kyrei session-mirror] user append dual-commit failed:", userCommit.error);
        }
      }
    }

    emitActiveTurnEvent(turn, {
      type: "message.start",
      payload: { session_id: sessionId, message_id: turn.draftId },
    });
    if (storedUser && config.workspace) {
      const promptWorkspace = await realpath(config.workspace).catch(() => "");
      // A force-cancelled or shutdown turn can resume after this filesystem
      // await. It no longer owns the session and must not mutate a newer turn
      // or schedule another store write after shutdown.
      if (!ownsActiveTurn(turn)) {
        await finalizeActiveTurn(turn, { status: "interrupted" });
        releaseActiveTurn(turn);
        return { status: "cancelled", sessionId, error: "interrupted" };
      }
      if (promptWorkspace) store.updateMessage(sessionId, storedUser.id, { workspace: promptWorkspace });
    }

    let mainTarget;
    let mainTargets = [];
    // Wave G2: prefer modelAssignments for explicit coding modes (plan/build/polish/deepreep).
    const modeRole = codingModeToAssignmentRole(session?.codingMode);
    const roleTarget = modeRole ? roleAssignmentRuntimeTarget(modeRole, sessionId) : undefined;
    try {
      if (roleTarget) {
        mainTarget = roleTarget;
        mainTargets = [roleTarget];
        // Also keep session-model accounts as capacity spares after the role model.
        try {
          const sessionTargets = privateRuntimeTargetsForConfig(
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
          for (const t of sessionTargets) {
            if (t.providerId === mainTarget.providerId && t.model === mainTarget.model
              && (t.accountId ?? "") === (mainTarget.accountId ?? "")) {
              continue;
            }
            mainTargets.push(t);
          }
        } catch {
          /* role target alone is enough */
        }
      } else {
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
      }
    } catch {
      emitActiveTurnEvent(turn, { type: "error", payload: { code: "provider_not_configured" } });
      await finalizeActiveTurn(turn, { status: "error" });
      releaseActiveTurn(turn);
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

    activePromptProviders.set(sessionId, new Set(config.providers.map((provider) => provider.id)));

    try {
      const activeTeamProfile = activeOrchestrationProfile(config);
      const explicitPromptSkills = Boolean(skillIds?.length && !activeTeamProfile);
      let runtimeSkills;
      if (activeTeamProfile) {
        runtimeSkills = await runtimeSkillsForTeamProfile(activeTeamProfile);
      } else if (explicitPromptSkills) {
        try {
          runtimeSkills = await runtimeSkillsForPrompt(skillIds, { strictRequested: true });
        } catch (error) {
          const code = error?.code === "runtime_skills_char_limit"
            ? "prompt_skills_runtime_budget_exceeded"
            : "prompt_skills_runtime_unavailable";
          emitActiveTurnEvent(turn, { type: "error", payload: { code } });
          await finalizeActiveTurn(turn, { status: "error" });
          return { status: "error", sessionId, error: code };
        }
      } else {
        runtimeSkills = await runtimeSkillsForPrompt(skillIds).catch(() => ({ skills: [] }));
      }
      throwIfAborted(controller.signal);
      const workerProvider = workerRuntimeTarget(sessionId);
      // Capacity chain: all accounts for primary model, then same-family models
      // on other providers, then configured fallbacks — so spare keys keep the job alive.
      const capacityCfg = normalizeCapacityConfig(config.capacity);
      const subscriptionShield = capacityCfg.subscriptionShield;
      const familyTargets = [];
      if (capacityCfg.enabled && capacityCfg.crossProviderFamily) {
        for (const ref of listFamilyModelRefs(config, mainTarget.providerId, mainTarget.model)) {
          try {
            const expanded = privateRuntimeTargetsForConfig(
              config,
              secrets,
              ref.providerId,
              ref.modelId,
              { sessionId, preferredAccountId: session.providerAccountId },
            );
            familyTargets.push(...expanded);
          } catch {
            /* sibling provider not ready */
          }
        }
      }
      const orderedCapacity = orderCapacityCandidates({
        primaryTargets: mainTargets,
        familyTargets,
        fallbackTargets: fallbackRuntimeTargets(sessionId),
        capacity: capacityCfg,
      });
      // First candidate is primary; rest feed openStream failover.
      if (orderedCapacity[0]) mainTarget = orderedCapacity[0];
      const fallbackProviders = orderedCapacity.slice(1);
      const team = activeTeamProfile
        ? teamRuntimeSpecForProfile(
            activeTeamProfile.id,
            mainTarget,
            runtimeSkills.skills,
            config,
            secrets,
            `session:${sessionId}`,
          )
        : undefined;
      if (activeTeamProfile && !team) throw new TeamConfigError("team_runtime_unavailable");
      const providerAttemptLifecycle = providerAttemptLifecycleFor({
        generationSnapshot: runtimeGenerationSnapshot,
        sessionId,
        preferredProviderId: mainTarget.providerId,
        preferredAccountId: session.providerAccountId,
        signal: controller.signal,
      });
      const turnMessages = await convoFor(sessionId);
      // Wave F: always pass a goal for harness (plan gate / goal-verify) from the
      // latest user turn when the client did not set one. No secrets — chat text only.
      let derivedGoal = "";
      for (let i = turnMessages.length - 1; i >= 0; i--) {
        const m = turnMessages[i];
        if (!m || m.role !== "user") continue;
        if (typeof m.content === "string" && m.content.trim()) {
          derivedGoal = m.content.trim().slice(0, 4_000);
          break;
        }
        if (Array.isArray(m.content)) {
          const text = m.content
            .map((part) => (typeof part === "string" ? part : (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")))
            .filter(Boolean)
            .join("\n")
            .trim();
          if (text) {
            derivedGoal = text.slice(0, 4_000);
            break;
          }
        }
      }
      const common = {
        emit: event => emitActiveTurnEvent(turn, event),
        messages: turnMessages,
        providerBase: mainTarget.baseURL,
        providerProtocol: mainTarget.protocol,
        providerId: mainTarget.providerId,
        providerAccountId: mainTarget.accountId,
        providerHeaders: mainTarget.headers,
        requiresApiKey: mainTarget.requiresApiKey,
        apiKey: mainTarget.apiKey,
        providerCredentials: mainTarget.credentials,
        model: mainTarget.model,
        ...(mainTarget.limits ? { modelLimits: { ...mainTarget.limits } } : {}),
        providerAttemptLifecycle,
        subscriptionShield,
        ...(workerProvider ? { workerProvider } : {}),
        ...(fallbackProviders.length ? { fallbackProviders } : {}),
        ...(team ? { team } : {}),
        ...(derivedGoal ? { goal: derivedGoal } : {}),
        workspace: config.workspace,
        globalMemoryDir: join(dataDir, "memory"),
        sessionMirrorDir: join(dataDir, "session-mirror"),
        auditLogPath: join(dataDir, "audit.jsonl"),
        sessionId,
        approvalSecret: secrets.approvalSigningKey,
        onApprovalConsumed: async (approvalId) => {
          assertTurnOwnsSessionMutation(turn);
          store.consumeApproval(sessionId, approvalId);
          // This is an effect barrier, not a debounced UI write: an approved
          // command may start only after its one-shot consumption is durable.
          await store.flush();
        },
        ...(commandRunner ? { commandRunner } : {}),
        skills: runtimeSkillsForEngine(runtimeSkills.skills),
        ...(skillIds?.length && !activeTeamProfile ? { requiredSkillIds: skillIds } : {}),
        readSkillDocument: (skillId, documentId) => skillsStore.readRuntimeDocument(skillId, documentId),
        onSkillUsed: id => skillsStore.recordUsage(id).then(() => undefined).catch(() => undefined),
      };
      const mod = await getEngine();
      throwIfAborted(controller.signal);
      const result = await mod.runKyreiChat({
        ...common,
        abortSignal: controller.signal,
        config: engineConfigForSession(sessionId),
        ...(safeModelParams ? { modelParams: safeModelParams } : {}),
      });
      // Wave E: remember last harness snapshot for Usage settings (no secrets).
      if (result?.harness && typeof result.harness === "object") {
        lastHarnessMetrics = sanitizeHarnessMetrics(result.harness);
      }
      // UI parts and structured model history can legitimately share the same
      // tool input object. Redact them as separate roots: the generic cycle
      // guard otherwise replaces the second reference with "[CIRCULAR]" and
      // invalidates the HMAC-bound approval request on continuation.
      const sensitiveValues = runtimeSensitiveValues();
      const publicResult = redactSensitiveValue(
        { ...result, responseMessages: undefined },
        sensitiveValues,
      );
      const privateResponseMessages = redactSensitiveValue(
        result?.responseMessages,
        sensitiveValues,
      );
      const assistantText = typeof publicResult?.text === "string" ? publicResult.text : "";
      const assistantParts = Array.isArray(publicResult?.parts) ? publicResult.parts : [];
      const assistantModelMessages = internalModelMessages(privateResponseMessages);
      const turnStatus = typeof result?.status === "string" ? result.status : "complete";
      // A provider may resolve despite aborting its transport. An explicitly
      // interrupted engine result is useful partial work; every other late
      // result remains fenced and cannot overwrite the durable cancellation.
      if (controller.signal.aborted && turnStatus !== "interrupted") {
        throwIfAborted(controller.signal);
      }
      const successfulTurn = turnStatus === "complete"
        || turnStatus === "max_steps"
        || turnStatus === "awaiting_approval"
        || turnStatus === "awaiting_file_review"
        || turnStatus === "goal_unsatisfied"
        || turnStatus === "budget_exceeded"
        || turnStatus === "heal_handoff";
      const fileReview = publicResult?.fileReview && typeof publicResult.fileReview === "object"
        ? publicResult.fileReview
        : undefined;
      await finalizeActiveTurn(turn, {
        status: turnStatus,
        text: assistantText,
        parts: assistantParts,
        modelMessages: assistantModelMessages,
        ...(turnStatus === "awaiting_approval" && safeModelParams
          ? { approvalModelParams: safeModelParams }
          : {}),
        ...(fileReview ? { fileReview } : {}),
      });
      // Accounting ledger (no prompts/secrets): supports multi-model pooling UX.
      try {
        const usage = result?.usage && typeof result.usage === "object" ? result.usage : null;
        const route = result?.route && typeof result.route === "object" ? result.route : null;
        const inputTokens = Number(usage?.inputTokens);
        const outputTokens = Number(usage?.outputTokens);
        const totalTokens = Number(usage?.totalTokens)
          || ((Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0));
        if (totalTokens > 0 || Number(usage?.costUsd) > 0) {
          recordChatUsage({
            kind: "chat_turn",
            sessionId,
            providerId: route?.providerId ?? mainTarget.providerId,
            accountId: route?.accountId ?? mainTarget.accountId,
            modelId: route?.modelId ?? mainTarget.model,
            ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
            ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
            totalTokens,
            ...(Number.isFinite(Number(usage?.costUsd)) ? { costUsd: Number(usage.costUsd) } : {}),
            status: turnStatus,
            latencyMs: Date.now() - (runtimeActivity.get(sessionId)?.startedAt ?? Date.now()),
            ...(accessPrincipal?.id ? {
              accessTokenId: accessPrincipal.id,
              principalLabel: accessPrincipal.principal?.label ?? accessPrincipal.id,
            } : {}),
          });
          if (accessPrincipal?.id) touchAccessPrincipal(accessPrincipal.id);
        }
      } catch {
        /* ledger never blocks the agent turn */
      }
      // Project chat text into the rebuildable search index. Engine dual-commit
      // already ran inside finalizeActiveTurn (A4c); re-sync only if needed later.
      if (successfulTurn) {
        scheduleSessionMemoryProject(sessionId);
        // Fail-open catch-up when enginePrimary is off (finalize used fail-open).
        if (!sessionMirrorEnginePrimary()) void mirrorGatewaySession(sessionId);
      }
      // A non-cooperative provider can resolve after cancellation (including
      // with an explicit `interrupted` status). Its visible draft was already
      // finalized above, but it no longer owns this session and must not make
      // a late metadata write after gateway shutdown or a newer turn starts.
      if (!ownsActiveTurn(turn)) {
        return { status: "cancelled", sessionId, error: "interrupted" };
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
      return {
        status: turnStatus === "awaiting_approval"
          ? "awaiting_approval"
          : turnStatus === "awaiting_file_review"
            ? "awaiting_file_review"
            : "success",
        sessionId,
        summary: assistantText.slice(0, 4000),
      };
    } catch (err) {
      // A synchronous throw or a failed engine-bundle import must not become an
      // unhandled rejection (would crash the gateway) — surface it and end turn.
      const aborted = controller.signal.aborted || err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));
      const publicError = redactSensitiveText(err?.message || String(err), runtimeSensitiveValues());
      if (aborted) {
        await finalizeActiveTurn(turn, { status: "interrupted" });
      } else {
        emitActiveTurnEvent(turn, { type: "error", payload: { message: publicError } });
        await finalizeActiveTurn(turn, { status: "error" });
      }
      return { status: aborted ? "cancelled" : "error", sessionId, error: publicError };
    } finally {
      releaseActiveTurn(turn);
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
    if (gatewayClosing) return sendJson(res, 503, { code: "gateway_shutdown", error: "gateway_shutdown" });
    let finishRequest;
    const activeRequest = {
      done: new Promise((resolve) => { finishRequest = resolve; }),
    };
    activeHttpRequests.add(activeRequest);
    req.kyreiShutdownSignal = shutdownController.signal;
    try {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    res.kyreiCors = corsFor(origin);

    // Default: loopback-only. When proxy.listenLan is enabled, non-loopback
    // Host is allowed only for /v1/* and /health (OpenAI-compat employees).
    const proxyCfg = normalizeProxyConfig(config.proxy);
    const isV1Path = path === "/v1" || path.startsWith("/v1/");
    if (!isLoopbackHost(req.headers.host)) {
      if (!(proxyCfg.listenLan && (isV1Path || path === "/health"))) {
        return sendJson(res, 421, { error: "loopback host required" });
      }
    }
    if (!isExpectedOrigin(origin)) {
      // OpenAI-compat clients often omit Origin; allow empty origin on /v1.
      if (!(isV1Path && !origin)) {
        return sendJson(res, 403, { error: "unexpected origin" });
      }
    }
    if (req.method === "OPTIONS") {
      if (!origin && !isV1Path) return sendJson(res, 403, { error: "origin required" });
      res.writeHead(204, {
        ...res.kyreiCors,
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Kyrei-Gateway-Token, X-Kyrei-Access-Token",
      });
      res.end();
      return;
    }
    const headerToken = Array.isArray(req.headers["x-kyrei-gateway-token"])
      ? req.headers["x-kyrei-gateway-token"][0]
      : req.headers["x-kyrei-gateway-token"];
    const eventToken = path === "/api/events" ? url.searchParams.get("token") : null;
    const gatewayAuthOk = tokenMatches(headerToken) || tokenMatches(eventToken);
    // /v1 may authenticate with employee access token alone (company proxy).
    let v1Principal = null;
    if (isV1Path && path !== "/health") {
      try {
        const plain = extractAccessTokenFromRequest(req);
        if (plain) {
          v1Principal = resolveAccessPrincipal(plain, accessControlState(), accessTokenHashes());
          if (!v1Principal) {
            return sendJson(res, 401, { error: "invalid_api_key", code: "access_token_invalid" });
          }
        } else if (proxyCfg.requireAccessToken || !gatewayAuthOk) {
          return sendJson(res, 401, { error: "invalid_api_key", code: "access_token_required" });
        }
      } catch (error) {
        if (error instanceof AccessTokenError) {
          return sendJson(res, error.status || 401, { error: error.code, code: error.code });
        }
        throw error;
      }
    } else if (path !== "/health" && !gatewayAuthOk) {
      return sendJson(res, 401, { error: "gateway authentication required" });
    }

    try {
      if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });

      // ── OpenAI-compatible proxy (/v1) ────────────────────────────────
      if (proxyCfg.enabled && path === "/v1/models" && req.method === "GET") {
        return sendJson(res, 200, listCompatModels(config));
      }
      if (proxyCfg.enabled && path === "/v1/chat/completions" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = parseChatCompletionRequest(body);
        if (!parsed.ok) {
          return sendJson(res, 400, { error: { message: parsed.error, type: "invalid_request_error" } });
        }
        // Budgets: global then principal
        try {
          const budget = await usageBudgetSnapshot();
          if (budget.blocked) {
            return sendJson(res, 429, {
              error: { message: "budget_exceeded", type: "insufficient_quota", code: "budget_exceeded" },
              reasons: budget.hardReasons,
            });
          }
          if (v1Principal?.principal) {
            const pb = await principalBudgetSnapshot(v1Principal.principal);
            if (pb?.blocked) {
              return sendJson(res, 429, {
                error: {
                  message: "principal_budget_exceeded",
                  type: "insufficient_quota",
                  code: "principal_budget_exceeded",
                },
                reasons: pb.hardReasons,
              });
            }
          }
        } catch {
          /* fail-open */
        }

        const ref = resolveCompatModelRef(parsed.model, config);
        let target;
        try {
          target = privateRuntimeTargetForConfig(config, secrets, ref.providerId, ref.modelId, {
            fallbackToDefault: true,
          });
        } catch (error) {
          const code = error?.code || error?.message || "model_not_found";
          return sendJson(res, 404, {
            error: { message: String(code), type: "invalid_request_error", code: "model_not_found" },
          });
        }

        const modelMessages = openAiMessagesToModelMessages(parsed.messages);
        if (!modelMessages.length) {
          return sendJson(res, 400, {
            error: { message: "messages_required", type: "invalid_request_error" },
          });
        }

        const startedAt = Date.now();
        const completionId = newCompletionId();
        const modelLabel = `${target.providerId}/${target.model}`;
        try {
          const mod = await getEngine();
          if (typeof mod.buildModel !== "function") {
            return sendJson(res, 503, {
              error: { message: "engine_unavailable", type: "server_error" },
            });
          }
          const { generateText } = await import("ai");
          const languageModel = mod.buildModel({
            protocol: target.protocol,
            baseURL: target.baseURL,
            apiKey: target.apiKey || "",
            credentials: target.credentials || {},
            model: target.model,
            ...(target.headers ? { headers: target.headers } : {}),
          });
          const result = await generateText({
            model: languageModel,
            messages: modelMessages,
            maxRetries: 1,
          });
          const text = typeof result.text === "string" ? result.text : "";
          const usageRaw = result.usage && typeof result.usage === "object" ? result.usage : {};
          const inputTokens = Number(usageRaw.inputTokens ?? usageRaw.promptTokens) || 0;
          const outputTokens = Number(usageRaw.outputTokens ?? usageRaw.completionTokens) || 0;
          const totalTokens = Number(usageRaw.totalTokens) || inputTokens + outputTokens;
          // Cost estimate: optional registry entry if engine exposes cost metadata later.
          const costUsd = undefined;

          recordChatUsage({
            kind: "other",
            providerId: target.providerId,
            accountId: target.accountId,
            modelId: target.model,
            inputTokens,
            outputTokens,
            totalTokens,
            ...(costUsd !== undefined ? { costUsd } : {}),
            status: "complete",
            latencyMs: Date.now() - startedAt,
            ...(v1Principal?.id ? {
              accessTokenId: v1Principal.id,
              principalLabel: v1Principal.principal?.label ?? v1Principal.id,
            } : {}),
          });
          if (v1Principal?.id) touchAccessPrincipal(v1Principal.id);

          const payload = formatChatCompletionResponse({
            id: completionId,
            model: modelLabel,
            text,
            usage: { inputTokens, outputTokens, totalTokens },
          });

          if (parsed.stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              ...(res.kyreiCors ?? {}),
            });
            for (const frame of formatChatCompletionSseFrames({
              id: completionId,
              model: modelLabel,
              text,
            })) {
              res.write(frame);
            }
            res.end();
            return;
          }
          return sendJson(res, 200, payload);
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          const message = redactSensitiveText(raw, runtimeSensitiveValues()).slice(0, 500);
          return sendJson(res, 502, {
            error: { message, type: "server_error" },
          });
        }
      }
      if (isV1Path && proxyCfg.enabled === false) {
        return sendJson(res, 404, { error: { message: "proxy_disabled", type: "invalid_request_error" } });
      }
      if (isV1Path) {
        return sendJson(res, 404, { error: { message: "not_found", type: "invalid_request_error" } });
      }

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
          providerReady: Boolean(activeProvider && hasReadyProviderCredentials(activeProvider, secrets, config)),
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
          ...(lastHarnessMetrics ? { harness: lastHarnessMetrics } : {}),
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

      if (path === "/api/usage") {
        if (req.method === "GET") {
          const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
          const summary = await usageLedger.summary({ days });
          const budget = await usageBudgetSnapshot();
          return sendJson(res, 200, {
            days,
            ...summary,
            budget,
            ...(lastHarnessMetrics ? { harness: lastHarnessMetrics } : {}),
          });
        }
      }
      if (path === "/api/usage/budget") {
        if (req.method === "GET") {
          return sendJson(res, 200, await usageBudgetSnapshot());
        }
      }
      if (path === "/api/usage/events") {
        if (req.method === "GET") {
          const limit = Math.min(2_000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
          const events = await usageLedger.readEvents({ limit });
          return sendJson(res, 200, { events });
        }
      }

      // ── Access tokens (employee principals) ─────────────────────────
      if (path === "/api/access-tokens") {
        if (req.method === "GET") {
          return sendJson(res, 200, publicAccessControl(config.accessControl));
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const control = accessControlState();
          if (control.principals.length >= 256) {
            return sendJson(res, 400, { code: "access_token_limit", error: "access_token_limit" });
          }
          const created = createAccessPrincipal({
            label: typeof body.label === "string" ? body.label : "User",
            existing: control.principals,
            budget: {
              window: body.budgetWindow === "month" ? "month" : "day",
              softCostUsd: body.softCostUsd,
              hardCostUsd: body.hardCostUsd,
              softTokens: body.softTokens,
              hardTokens: body.hardTokens,
            },
          });
          const nextControl = normalizeAccessControl({
            ...control,
            principals: [...control.principals, created.principal],
          });
          const nextHashes = {
            ...accessTokenHashes(),
            [created.principal.id]: created.hash,
          };
          await mutateConfig(async () => {
            config = normalizeGatewayConfig({ ...config, accessControl: nextControl });
            secrets = normalizeProviderSecrets({
              ...secrets,
              accessTokenHashes: nextHashes,
            });
            await saveConfig(config, secrets);
          });
          return sendJson(res, 200, {
            principal: created.principal,
            // Shown once — never readable again from the store.
            token: created.plain,
            accessControl: publicAccessControl(config.accessControl),
          });
        }
        if (req.method === "PUT") {
          // Update requireToken flag only (principals use PATCH/POST/DELETE).
          const body = await readBody(req);
          const control = accessControlState();
          await mutateConfig(async () => {
            config = normalizeGatewayConfig({
              ...config,
              accessControl: {
                ...control,
                requireToken: body.requireToken === true,
              },
            });
            await saveConfig(config, secrets);
          });
          return sendJson(res, 200, publicAccessControl(config.accessControl));
        }
      }
      const accessTokenMatch = path.match(/^\/api\/access-tokens\/([^/]+)(?:\/(regenerate))?$/);
      if (accessTokenMatch) {
        let principalId = "";
        try {
          principalId = decodeURIComponent(accessTokenMatch[1]).trim();
        } catch {
          return sendJson(res, 400, { code: "access_token_id_invalid", error: "access_token_id_invalid" });
        }
        const action = accessTokenMatch[2] || "";
        const control = accessControlState();
        const existing = control.principals.find((row) => row.id === principalId);
        if (!existing) {
          return sendJson(res, 404, { code: "access_token_not_found", error: "access_token_not_found" });
        }

        if (req.method === "PATCH" && !action) {
          const body = await readBody(req);
          const nextPrincipal = patchPrincipal(existing, body);
          const nextControl = normalizeAccessControl({
            ...control,
            principals: control.principals.map((row) => (row.id === principalId ? nextPrincipal : row)),
          });
          await mutateConfig(async () => {
            config = normalizeGatewayConfig({ ...config, accessControl: nextControl });
            await saveConfig(config, secrets);
          });
          return sendJson(res, 200, {
            principal: nextPrincipal,
            accessControl: publicAccessControl(config.accessControl),
          });
        }

        if (req.method === "DELETE" && !action) {
          const nextControl = normalizeAccessControl({
            ...control,
            principals: control.principals.filter((row) => row.id !== principalId),
          });
          const nextHashes = { ...accessTokenHashes() };
          delete nextHashes[principalId];
          await mutateConfig(async () => {
            config = normalizeGatewayConfig({ ...config, accessControl: nextControl });
            secrets = normalizeProviderSecrets({
              ...secrets,
              accessTokenHashes: nextHashes,
            });
            await saveConfig(config, secrets);
          });
          return sendJson(res, 200, {
            ok: true,
            accessControl: publicAccessControl(config.accessControl),
          });
        }

        if (req.method === "POST" && action === "regenerate") {
          const regen = regenerateAccessPrincipal(existing);
          const nextControl = normalizeAccessControl({
            ...control,
            principals: control.principals.map((row) => (row.id === principalId ? regen.principal : row)),
          });
          const nextHashes = {
            ...accessTokenHashes(),
            [principalId]: regen.hash,
          };
          await mutateConfig(async () => {
            config = normalizeGatewayConfig({ ...config, accessControl: nextControl });
            secrets = normalizeProviderSecrets({
              ...secrets,
              accessTokenHashes: nextHashes,
            });
            await saveConfig(config, secrets);
          });
          return sendJson(res, 200, {
            principal: regen.principal,
            token: regen.plain,
            accessControl: publicAccessControl(config.accessControl),
          });
        }
      }

      if (path === "/api/experimental/browser-subscription" || path.startsWith("/api/experimental/browser-subscription/")) {
        const {
          BrowserSubscriptionAuthError,
          bindBrowserSubscriptionToken,
          deleteBrowserSubscriptionDeviceProfile,
          deleteBrowserSubscriptionSession,
          linkBrowserSubscriptionProvider,
          pollBrowserSubscriptionDeviceSession,
          publicBrowserSubscriptionSnapshot,
          revokeBrowserSubscriptionSession,
          setActiveBrowserSubscriptionDeviceProfile,
          startBrowserSubscriptionSession,
          upsertBrowserSubscriptionDeviceProfile,
        } = await import("./browser-subscription-auth.js");

        if (path === "/api/experimental/browser-subscription" && req.method === "GET") {
          return sendJson(res, 200, publicBrowserSubscriptionSnapshot(config, secrets));
        }

        if (path === "/api/experimental/browser-subscription/profiles" && req.method === "POST") {
          const body = await readBody(req);
          let result = null;
          await mutateConfig(async () => {
            const saved = upsertBrowserSubscriptionDeviceProfile(config, secrets, body);
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: saved.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: saved.secrets,
            });
            await saveConfig(config, secrets);
            result = {
              profile: saved.profile,
              snapshot: publicBrowserSubscriptionSnapshot(config, secrets),
            };
          });
          return sendJson(res, 200, result);
        }

        const profileActiveMatch = path.match(/^\/api\/experimental\/browser-subscription\/profiles\/([^/]+)\/activate$/);
        if (profileActiveMatch && req.method === "POST") {
          const profileId = decodeURIComponent(profileActiveMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const browserSubscription = setActiveBrowserSubscriptionDeviceProfile(config, profileId);
            config = normalizeGatewayConfig({ ...config, browserSubscription });
            await saveConfig(config, secrets);
            result = { snapshot: publicBrowserSubscriptionSnapshot(config, secrets) };
          });
          return sendJson(res, 200, result);
        }

        const profileDeleteMatch = path.match(/^\/api\/experimental\/browser-subscription\/profiles\/([^/]+)$/);
        if (profileDeleteMatch && req.method === "DELETE") {
          const profileId = decodeURIComponent(profileDeleteMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const removed = deleteBrowserSubscriptionDeviceProfile(config, secrets, profileId);
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: removed.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: removed.secrets,
            });
            await saveConfig(config, secrets);
            result = { snapshot: publicBrowserSubscriptionSnapshot(config, secrets) };
          });
          return sendJson(res, 200, result);
        }

        if (path === "/api/experimental/browser-subscription/sessions" && req.method === "POST") {
          const body = await readBody(req);
          let result = null;
          await mutateConfig(async () => {
            const started = await startBrowserSubscriptionSession(config, secrets, body);
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: started.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: started.secrets,
            });
            await saveConfig(config, secrets);
            result = {
              session: started.session,
              nextStep: started.nextStep,
              snapshot: publicBrowserSubscriptionSnapshot(config, secrets),
            };
          });
          return sendJson(res, 200, result);
        }

        const pollMatch = path.match(/^\/api\/experimental\/browser-subscription\/sessions\/([^/]+)\/poll$/);
        if (pollMatch && req.method === "POST") {
          const sessionId = decodeURIComponent(pollMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const polled = await pollBrowserSubscriptionDeviceSession(config, secrets, sessionId);
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: polled.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: polled.secrets,
            });
            await saveConfig(config, secrets);
            result = {
              session: polled.session,
              pollStatus: polled.pollStatus,
              snapshot: publicBrowserSubscriptionSnapshot(config, secrets),
            };
          });
          return sendJson(res, 200, result);
        }

        const bindMatch = path.match(/^\/api\/experimental\/browser-subscription\/sessions\/([^/]+)\/token$/);
        if (bindMatch && req.method === "POST") {
          const body = await readBody(req);
          const sessionId = decodeURIComponent(bindMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const bound = bindBrowserSubscriptionToken(config, secrets, {
              ...body,
              sessionId,
            });
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: bound.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: bound.secrets,
            });
            await saveConfig(config, secrets);
            result = {
              session: bound.session,
              snapshot: publicBrowserSubscriptionSnapshot(config, secrets),
            };
          });
          return sendJson(res, 200, result);
        }

        const linkMatch = path.match(/^\/api\/experimental\/browser-subscription\/sessions\/([^/]+)\/link$/);
        if (linkMatch && req.method === "POST") {
          const body = await readBody(req);
          const sessionId = decodeURIComponent(linkMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const browserSubscription = linkBrowserSubscriptionProvider(
              config,
              sessionId,
              body?.providerId,
            );
            let providers = config.providers;
            const providerId = typeof body?.providerId === "string"
              ? body.providerId.trim().toLowerCase()
              : "";
            if (providerId) {
              providers = config.providers.map((provider) => (
                provider.id === providerId
                  ? {
                      ...provider,
                      credentialSource: "browser-subscription",
                      browserSubscriptionSessionId: sessionId,
                      requiresApiKey: true,
                    }
                  : provider
              ));
            }
            config = normalizeGatewayConfig({
              ...config,
              providers,
              browserSubscription,
            });
            await saveConfig(config, secrets);
            result = {
              snapshot: publicBrowserSubscriptionSnapshot(config, secrets),
              config: publicGatewayConfig(config, secrets),
            };
          });
          return sendJson(res, 200, result);
        }

        const revokeMatch = path.match(/^\/api\/experimental\/browser-subscription\/sessions\/([^/]+)\/revoke$/);
        if (revokeMatch && req.method === "POST") {
          const sessionId = decodeURIComponent(revokeMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const revoked = revokeBrowserSubscriptionSession(config, secrets, sessionId);
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: revoked.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: revoked.secrets,
            });
            await saveConfig(config, secrets);
            result = {
              session: revoked.session,
              snapshot: publicBrowserSubscriptionSnapshot(config, secrets),
            };
          });
          return sendJson(res, 200, result);
        }

        const deleteMatch = path.match(/^\/api\/experimental\/browser-subscription\/sessions\/([^/]+)$/);
        if (deleteMatch && req.method === "DELETE") {
          const sessionId = decodeURIComponent(deleteMatch[1]);
          let result = null;
          await mutateConfig(async () => {
            const removed = deleteBrowserSubscriptionSession(config, secrets, sessionId);
            config = normalizeGatewayConfig({
              ...config,
              browserSubscription: removed.config,
            });
            secrets = normalizeProviderSecrets({
              ...secrets,
              browserSubscription: removed.secrets,
            });
            await saveConfig(config, secrets);
            result = { snapshot: publicBrowserSubscriptionSnapshot(config, secrets) };
          });
          return sendJson(res, 200, result);
        }

        void BrowserSubscriptionAuthError;
        return sendJson(res, 404, { error: "not_found" });
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
            const availableSkillIds = orchestrationExplicit
              ? new Set((await skillsStore.list()).filter((skill) => skill.enabled).map((skill) => skill.id))
              : undefined;
            const providersExplicit = Array.isArray(body.providers) && body.providers.length > 0;
            if (providersExplicit) {
            const importedProviders = [];
            const importedIds = new Set();
            const previousProviders = new Map(config.providers.map((provider) => [provider.id, provider]));
            for (const row of body.providers) {
              const existingProvider = previousProviders.get(typeof row?.id === "string" ? row.id.trim() : "");
              const provider = validateProviderInput(row, {
                creating: true,
                verifyLiveCapabilities: liveCapabilityVerifier(existingProvider),
              });
              if (importedIds.has(provider.id)) throw new ProviderConfigError("provider_id_conflict");
              importedIds.add(provider.id);
              importedProviders.push(provider);
            }
            const previousActiveProviderId = config.activeProviderId;
            const previousActiveModelId = config.activeModelId;
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
            // The engine still performs defensive runtime normalization. User
            // prompt profiles are additionally strict at this durable boundary
            // so invalid assignments never become silent runtime fallbacks.
            if (Object.hasOwn(body, "proxy")) {
              nextConfig = normalizeGatewayConfig({
                ...nextConfig,
                proxy: body.proxy,
              });
            }
            if (Object.hasOwn(body, "capacity")) {
              nextConfig = normalizeGatewayConfig({
                ...nextConfig,
                capacity: body.capacity,
              });
            }
            if (Object.hasOwn(body, "experimental")) {
              const {
                acceptExperimentalDisclaimer,
                normalizeExperimentalConfig,
                EXPERIMENTAL_ACCEPT_PHRASE,
              } = await import("./experimental-features.js");
              const companyLocked = nextConfig.accessControl?.requireToken === true;
              const previous = normalizeExperimentalConfig(nextConfig.experimental, { companyLocked });
              const requested = body.experimental && typeof body.experimental === "object"
                ? body.experimental
                : {};
              let experimental = requested;
              // Unlock requires the exact accept phrase so the UI checkbox alone
              // is not enough if someone crafts a raw PUT.
              if (requested.unlocked === true && !previous.unlocked && !companyLocked) {
                try {
                  experimental = acceptExperimentalDisclaimer(
                    {
                      ...requested,
                      features: requested.features,
                    },
                    { acceptPhrase: body.experimentalAcceptPhrase },
                  );
                } catch (error) {
                  if (error?.code === "experimental_accept_phrase_mismatch") {
                    throw new ProviderConfigError("experimental_accept_phrase_mismatch");
                  }
                  throw error;
                }
                // Re-apply feature toggles the operator selected after accept.
                experimental = normalizeExperimentalConfig({
                  ...experimental,
                  features: requested.features,
                }, { companyLocked });
              } else if (requested.unlocked !== true) {
                experimental = normalizeExperimentalConfig({
                  unlocked: false,
                  acceptedAt: null,
                  acceptedDisclaimerVersion: null,
                  features: Object.fromEntries(
                    Object.keys(previous.features || {}).map((id) => [id, false]),
                  ),
                }, { companyLocked });
              } else {
                experimental = normalizeExperimentalConfig({
                  ...previous,
                  ...requested,
                  unlocked: true,
                  acceptedAt: previous.acceptedAt,
                  acceptedDisclaimerVersion: previous.acceptedDisclaimerVersion,
                }, { companyLocked });
              }
              void EXPERIMENTAL_ACCEPT_PHRASE;
              nextConfig = normalizeGatewayConfig({
                ...nextConfig,
                experimental,
              });
            }
            if (Object.hasOwn(body, "engine")) {
              nextConfig = { ...nextConfig, engine: validateEngineConfigBoundary(body.engine) };
            }
            if (orchestrationExplicit) {
              const promptProfileIds = promptProfileIdsForEngine(nextConfig.engine);
              nextConfig = {
                ...nextConfig,
                orchestration: validateOrchestrationInput(body.orchestration, nextConfig.providers, {
                  promptProfileIds,
                  skillIds: availableSkillIds,
                }),
              };
            }
            validatePromptProfileAssignments(nextConfig.engine, nextConfig.orchestration);
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
            nextConfig = await ensureBuiltinTeamMemory(nextConfig);
            nextSecrets = pruneProviderAccountSecrets(nextSecrets, nextConfig.providers);
            const previousWorkspace = typeof config.workspace === "string" ? config.workspace : "";
            if (typeof body.workspace === "string") {
              await saveConfigWithWorkspace({
                previousWorkspace,
                nextWorkspace: nextConfig.workspace,
                skillsStore,
                saveConfig: () => saveConfig(nextConfig, nextSecrets),
              });
            } else {
              await saveConfig(nextConfig, nextSecrets);
            }
            config = nextConfig;
            secrets = nextSecrets;
            invalidateAllProviderRuntimes();
            if (selectionExplicit) rebindUnreadyIdleSessions(config, secrets);
            const nextWorkspace = typeof nextConfig.workspace === "string" ? nextConfig.workspace.trim() : "";
            const prevWs = previousWorkspace.trim().replace(/\\/g, "/").toLowerCase();
            const nextWs = nextWorkspace.replace(/\\/g, "/").toLowerCase();
            if (nextWorkspace && nextWs !== prevWs) {
              // Await so "Open folder" finishes with DBs ready — not fire-and-forget.
              await bootstrapLocalDatabases("workspace-set");
            }
            return publicGatewayConfig(config, secrets);
          });
          return sendJson(res, 200, snapshot);
        }
      }

      // GBrain is an opt-in, local-only memory runtime. Its setup is exposed
      // separately from the broad engine JSON so users can understand exactly
      // what will happen before a local database is created.
      if (path === "/api/memory/gbrain" && req.method === "GET") {
        return sendJson(res, 200, await inspectGBrain());
      }

      if (path === "/api/memory/mcp" && req.method === "GET") {
        return sendJson(res, 200, await inspectMcp());
      }

      if (path === "/api/memory/local-postgres" && req.method === "GET") {
        return sendJson(res, 200, localPostgres?.getStatus?.() ?? {
          state: "unavailable",
          reason: "runtime_not_embedded",
        });
      }

      if (path === "/api/memory/local-postgres/ensure" && req.method === "POST") {
        return sendJson(res, 200, localPostgres?.ensure
          ? await localPostgres.ensure(config.workspace)
          : { state: "unavailable", reason: "runtime_not_embedded" });
      }

      if (path === "/api/memory/gbrain/initialize" && req.method === "POST") {
        return sendJson(res, 200, await initializeGBrain());
      }

      if (path === "/api/memory/gbrain/install" && req.method === "POST") {
        return sendJson(res, 200, await installAndInitializeGBrain());
      }

      if (path === "/api/memory/index" && req.method === "GET") {
        return sendJson(res, 200, await inspectBuiltinMemoryIndex());
      }

      if (path === "/api/memory/index/reindex" && req.method === "POST") {
        return sendJson(res, 200, await reindexBuiltinMemoryIndex({ refreshProjectIndex: true }));
      }

      if (path === "/api/memory/graph" && req.method === "GET") {
        const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
        if (!workspace) return sendJson(res, 400, { code: "workspace_not_configured", error: "workspace_not_configured" });
        try {
          const mod = await getEngine();
          if (typeof mod?.getWorkspaceMemoryGraph !== "function") {
            return sendJson(res, 503, { code: "memory_graph_unavailable", error: "memory_graph_unavailable" });
          }
          return sendJson(res, 200, await mod.getWorkspaceMemoryGraph({
            workspace,
            config: builtinMemoryIndexConfig(),
          }));
        } catch (error) {
          return sendJson(res, 500, {
            code: "memory_graph_failed",
            error: error?.message ?? "memory_graph_failed",
          });
        }
      }

      if (path === "/api/memory/documents/import" && req.method === "POST") {
        assertGatewayAcceptingMutations();
        const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
        if (!workspace) return sendJson(res, 400, { code: "workspace_not_configured", error: "workspace_not_configured" });
        const body = await readBody(req);
        const files = Array.isArray(body?.files) ? body.files.slice(0, 24) : [];
        if (!files.length) return sendJson(res, 400, { code: "documents_required", error: "documents_required" });
        const decoded = [];
        for (const file of files) {
          if (!file || typeof file !== "object") continue;
          const fileName = typeof file.fileName === "string" ? file.fileName.slice(0, 260) : "";
          const encoded = typeof file.contentBase64 === "string" ? file.contentBase64 : "";
          if (!fileName || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
          decoded.push({ fileName, bytes: new Uint8Array(Buffer.from(encoded, "base64")) });
        }
        if (!decoded.length) return sendJson(res, 400, { code: "documents_invalid", error: "documents_invalid" });
        try {
          const mod = await getEngine();
          if (typeof mod?.importProjectDocuments !== "function") {
            return sendJson(res, 503, { code: "document_import_unavailable", error: "document_import_unavailable" });
          }
          const result = await mod.importProjectDocuments({ workspace, files: decoded });
          if (!result.imported.length) return sendJson(res, 422, result);
          const reindex = await reindexBuiltinMemoryIndex({ refreshProjectIndex: true });
          return sendJson(res, 200, { ...result, reindex });
        } catch (error) {
          return sendJson(res, 500, {
            code: "document_import_failed",
            error: error?.message ?? "document_import_failed",
          });
        }
      }

      // Rebuild LTM runtime projection (files/ledger remain SoT).
      // Curate one session into notes / MEMORY / LTM / handoff catalogs.
      const curateMatch = path.match(/^\/api\/sessions\/([^/]+)\/curate-memory$/);
      if (curateMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(curateMatch[1]);
        if (!store.getSession(sessionId)) {
          return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
        }
        const body = await readBody(req).catch(() => ({}));
        const applyMode = body?.applyMode === "propose"
          || body?.applyMode === "apply_safe"
          || body?.applyMode === "apply_all"
          ? body.applyMode
          : undefined;
        const result = await runSessionCurator(sessionId, {
          ...(applyMode ? { applyModeOverride: applyMode } : {}),
        });
        if (!result.ok && result.error === "no_workspace") {
          return sendJson(res, 400, { code: "no_workspace", error: "no_workspace" });
        }
        return sendJson(res, 200, { ok: result.ok !== false, ...result });
      }

      // Batch curate (default: all archived sessions).
      if (path === "/api/memory/curator/batch" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const applyMode = body?.applyMode === "propose"
          || body?.applyMode === "apply_safe"
          || body?.applyMode === "apply_all"
          ? body.applyMode
          : undefined;
        const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds : undefined;
        const result = await runSessionCuratorBatch({
          sessionIds,
          ...(applyMode ? { applyModeOverride: applyMode } : {}),
        });
        return sendJson(res, 200, result);
      }

      // List / apply curator proposals (review UI).
      if (path === "/api/memory/curator/proposals" && req.method === "GET") {
        const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
        if (!workspace) return sendJson(res, 400, { code: "no_workspace", error: "no_workspace" });
        try {
          const mod = await getEngine();
          if (typeof mod.listCuratorProposals !== "function") {
            return sendJson(res, 503, { code: "adapter_unavailable", error: "adapter_unavailable" });
          }
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));
          const proposals = await mod.listCuratorProposals(workspace, { limit });
          // Strip full proposal bodies from list for bandwidth; include counts + meta.
          return sendJson(res, 200, {
            proposals: proposals.map((p) => ({
              fileName: p.fileName,
              path: p.path,
              sessionId: p.sessionId,
              title: p.title,
              via: p.via,
              applyMode: p.applyMode,
              status: p.status,
              at: p.at,
              applied: p.applied,
              proposalCount: p.proposalCount,
              preview: (p.proposals || []).slice(0, 3).map((x) => ({
                target: x.target,
                rationale: x.rationale,
                contentPreview: String(x.content || "").slice(0, 160),
              })),
            })),
          });
        } catch (error) {
          return sendJson(res, 500, {
            code: "list_proposals_failed",
            error: error?.message ?? "list_proposals_failed",
          });
        }
      }

      if (path === "/api/memory/curator/proposals/apply" && req.method === "POST") {
        const workspace = typeof config.workspace === "string" ? config.workspace.trim() : "";
        if (!workspace) return sendJson(res, 400, { code: "no_workspace", error: "no_workspace" });
        const body = await readBody(req).catch(() => ({}));
        const file = typeof body?.fileName === "string" && body.fileName
          ? body.fileName
          : typeof body?.path === "string"
            ? body.path
            : "";
        if (!file) return sendJson(res, 400, { code: "file_required", error: "file_required" });
        const applyMode = body?.applyMode === "apply_all" ? "apply_all" : "apply_safe";
        try {
          const mod = await getEngine();
          if (typeof mod.applyStoredCuratorProposal !== "function") {
            return sendJson(res, 503, { code: "adapter_unavailable", error: "adapter_unavailable" });
          }
          const result = await mod.applyStoredCuratorProposal(workspace, file, applyMode);
          if (result.ok && result.applied?.length) {
            void reindexBuiltinMemoryIndex().catch(() => undefined);
          }
          return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return sendJson(res, 500, {
            code: "apply_proposal_failed",
            error: error?.message ?? "apply_proposal_failed",
          });
        }
      }

      if (path === "/api/memory/ltm/consolidate" && req.method === "POST") {
        return sendJson(res, 200, await consolidateBuiltinLtm());
      }

      if (path === "/api/memory/ltm/decisions" && req.method === "GET") {
        const url = new URL(req.url || "/", "http://localhost");
        const includeInvalidated = url.searchParams.get("includeInvalidated") === "1"
          || url.searchParams.get("includeInvalidated") === "true";
        const result = await listLtmDecisionsApi({ includeInvalidated });
        const status = result.ok
          ? 200
          : result.error === "workspace_not_configured" || result.error === "ltm_disabled"
            ? 400
            : 503;
        return sendJson(res, status, result);
      }

      if (path === "/api/memory/ltm/decisions/fetch" && req.method === "GET") {
        const url = new URL(req.url || "/", "http://localhost");
        const id = url.searchParams.get("id") || "";
        const result = await fetchLtmDecisionApi(id);
        const status = result.ok
          ? 200
          : result.error === "not_found"
            ? 404
            : result.error === "workspace_not_configured"
              || result.error === "id_required"
              || result.error === "ltm_disabled"
              ? 400
              : 503;
        return sendJson(res, status, result);
      }

      if (path === "/api/memory/ltm/decisions/pin" && req.method === "POST") {
        assertGatewayAcceptingMutations();
        const body = await readBody(req).catch(() => ({}));
        const id = typeof body?.id === "string" ? body.id : "";
        const pinned = body?.pinned === true;
        const result = await pinLtmDecisionApi(id, pinned);
        const status = result.ok
          ? 200
          : result.error === "not_found"
            ? 404
            : result.error === "decision_superseded"
              ? 409
              : result.error === "workspace_not_configured"
                || result.error === "id_required"
                || result.error === "ltm_disabled"
                ? 400
                : 503;
        return sendJson(res, status, result);
      }

      // ── Messaging inbound webhook ─────────────────────────────────
      if (path === "/api/messaging" && req.method === "GET") {
        return sendJson(res, 200, publicMessagingStatus(
          messagingConfig(),
          secrets,
          messagingRecent,
        ));
      }

      if (path === "/api/messaging/token" && req.method === "POST") {
        assertGatewayAcceptingMutations();
        const token = generateMessagingToken();
        secrets = normalizeProviderSecrets({
          ...secrets,
          messaging: { webhookToken: token },
        });
        await saveConfig(config, secrets);
        // Return token once — never stored in public config.
        return sendJson(res, 200, {
          ok: true,
          token,
          status: publicMessagingStatus(messagingConfig(), secrets, messagingRecent),
        });
      }

      if (path === "/api/messaging/inbound" && req.method === "POST") {
        const msgCfg = messagingConfig();
        if (!msgCfg.enabled) {
          return sendJson(res, 403, { code: "messaging_disabled", error: "messaging_disabled" });
        }
        const body = await readBody(req);
        if (!messagingTokenEquals(extractMessagingToken(req, body))) {
          return sendJson(res, 401, { code: "messaging_unauthorized", error: "messaging_unauthorized" });
        }
        assertGatewayAcceptingMutations();
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length < 1) {
          return sendJson(res, 400, { code: "text_required", error: "text_required" });
        }
        if (text.length > msgCfg.maxBodyChars) {
          return sendJson(res, 413, { code: "text_too_long", error: "text_too_long" });
        }
        const safeText = redactSensitiveText(text, runtimeSensitiveValues());
        let sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        let created = false;
        if (sessionId) {
          if (!store.getSession(sessionId)) {
            return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
          }
        } else {
          const title = typeof body.title === "string" && body.title.trim()
            ? body.title.trim().slice(0, 80)
            : `Inbound ${new Date().toISOString().slice(0, 16)}`;
          const session = createSession({ title, source: "messaging" });
          sessionId = session.id;
          created = true;
        }
        const stored = store.appendMessage(sessionId, {
          role: "user",
          content: safeText,
          text: safeText,
          parts: [{ type: "text", text: safeText }],
        });
        store.upsertSession({
          id: sessionId,
          updatedAt: new Date().toISOString(),
          ...(created ? {} : {}),
        });
        await store.flush();
        const commit = await commitSessionToEngine(sessionId);
        if (!commit.ok && sessionMirrorEnginePrimary()) {
          return sendJson(res, 503, {
            code: "engine_mirror_write_failed",
            error: commit.error ?? "engine_mirror_write_failed",
          });
        }
        const eventId = `msg-in-${Date.now().toString(36)}`;
        let autoRunStarted = false;
        if (msgCfg.autoRun) {
          try {
            // Message already appended; continue without duplicating the user turn.
            void runPrompt(sessionId, "", undefined, undefined, undefined, { appendUser: false });
            autoRunStarted = true;
          } catch (error) {
            console.warn("[kyrei messaging] autoRun failed:", error?.message ?? error);
          }
        }
        pushMessagingRecent({
          id: eventId,
          at: new Date().toISOString(),
          channel: typeof body.channel === "string" ? body.channel.slice(0, 40) : "webhook",
          sessionId,
          preview: safeText.slice(0, 120),
          autoRun: autoRunStarted,
          status: "accepted",
        });
        emitTo(sessionId, {
          type: "message.start",
          payload: { session_id: sessionId, message_id: stored.id, source: "messaging" },
        });
        return sendJson(res, 200, {
          ok: true,
          sessionId,
          messageId: stored.id,
          created,
          autoRun: autoRunStarted,
          engineCommitted: Boolean(commit.ok && !commit.skipped),
        });
      }

      // Dual-write chat mirror: JSON remains SoT; engine store is FTS/read path.
      if (path === "/api/memory/session-mirror" && req.method === "GET") {
        await sessionMirrorSyncStateReady;
        const cfg = sessionMirrorConfig();
        if (!cfg.enabled) {
          return sendJson(res, 200, {
            enabled: false,
            readSearch: false,
            enginePrimary: false,
            state: "disabled",
            sessionCount: 0,
            message: "session_mirror_disabled",
            sync: sessionMirrorSyncProgress(),
          });
        }
        try {
          const mirror = await ensureSessionMirror();
          if (!mirror) {
            return sendJson(res, 200, {
              enabled: true,
              readSearch: cfg.readSearch,
              enginePrimary: cfg.enginePrimary,
              state: "error",
              sessionCount: 0,
              message: "mirror_unavailable",
              sync: sessionMirrorSyncProgress(),
            });
          }
          const sessions = await mirror.listSessions({
            ...(typeof config.workspace === "string" ? { workspace: config.workspace } : {}),
          });
          return sendJson(res, 200, {
            enabled: true,
            readSearch: cfg.readSearch,
            enginePrimary: cfg.enginePrimary,
            state: "ready",
            sessionCount: sessions.length,
            path: join(dataDir, "session-mirror"),
            note: cfg.enginePrimary
              ? "A4b: public GET prefers engine when caught up; JSON remains write path for approvals/rewind."
              : "JSON remains write path; mirror is dual-write FTS. Enable enginePrimary for public GET preference.",
            sync: sessionMirrorSyncProgress(),
          });
        } catch (error) {
          return sendJson(res, 200, {
            enabled: true,
            readSearch: cfg.readSearch,
            enginePrimary: cfg.enginePrimary,
            state: "error",
            sessionCount: 0,
            message: error?.message ?? "mirror_error",
            sync: sessionMirrorSyncProgress(),
          });
        }
      }

      if (path === "/api/memory/session-mirror/search" && req.method === "GET") {
        const cfg = sessionMirrorConfig();
        if (!cfg.enabled || !cfg.readSearch) {
          return sendJson(res, 403, { code: "session_mirror_read_disabled", error: "session_mirror_read_disabled" });
        }
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return sendJson(res, 400, { code: "query_required", error: "query_required" });
        try {
          const mirror = await ensureSessionMirror();
          if (!mirror) return sendJson(res, 503, { code: "mirror_unavailable", error: "mirror_unavailable" });
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20) || 20));
          const hits = await mirror.searchMessages(q, { limit });
          return sendJson(res, 200, {
            query: q,
            hits: hits.map((m) => ({
              sessionId: m.sessionId,
              seq: m.seq,
              role: m.role,
              text: typeof m.text === "string" ? m.text.slice(0, 500) : "",
              createdAt: m.createdAt,
            })),
          });
        } catch (error) {
          return sendJson(res, 500, { code: "mirror_search_failed", error: error?.message ?? "mirror_search_failed" });
        }
      }

      if (path === "/api/memory/session-mirror/sync" && req.method === "POST") {
        const cfg = sessionMirrorConfig();
        if (!cfg.enabled) {
          return sendJson(res, 403, { code: "session_mirror_disabled", error: "session_mirror_disabled" });
        }
        try {
          const result = await startOrResumeSessionMirrorSync();
          return sendJson(res, 202, {
            ok: true,
            ...result,
            sessions: result.totalSessions,
            messages: result.totalMessages,
            note: result.alreadyRunning
              ? "Session mirror synchronization is already running."
              : result.resumed
                ? "Resumed session mirror synchronization from the last durable checkpoint."
                : "Started background session mirror synchronization from JSON chat SoT.",
          });
        } catch (error) {
          return sendJson(res, 500, { code: "mirror_sync_failed", error: error?.message ?? "mirror_sync_failed" });
        }
      }

      // Progressive cutover readiness: compare JSON SoT vs engine mirror (never promotes SoT).
      if (path === "/api/memory/session-mirror/parity" && req.method === "GET") {
        const cfg = sessionMirrorConfig();
        const jsonSessions = Array.isArray(store.sessions) ? store.sessions : [];
        const jsonIds = new Set(jsonSessions.map((s) => s.id).filter(Boolean));
        let jsonMessages = 0;
        for (const session of jsonSessions) {
          jsonMessages += store.getMessages(session.id)?.length ?? 0;
        }
        // A4a schema + A4b GET primary + A4c dual-commit mutations when enginePrimary.
        const schemaReady = true;
        const enginePrimary = cfg.enginePrimary === true;
        const writeThrough = enginePrimary; // A4c: mutations dual-commit to engine (strict)
        const baseBlockers = enginePrimary
          ? ["json_mutation_logic_still_authoritative"]
          : ["engine_primary_disabled", "json_mutation_logic_still_authoritative"];
        if (!cfg.enabled) {
          return sendJson(res, 200, {
            enabled: false,
            schemaReady,
            enginePrimary: false,
            writeThrough: false,
            cutoverReady: false,
            json: { sessions: jsonIds.size, messages: jsonMessages },
            mirror: { sessions: 0, messages: 0 },
            missingInMirror: [...jsonIds].slice(0, 50),
            extraInMirror: [],
            blockers: ["session_mirror_disabled", ...baseBlockers],
            note: "Enable session mirror + enginePrimary for A4b GET + A4c dual-commit writes.",
          });
        }
        try {
          const mirror = await ensureSessionMirror();
          if (!mirror) {
            return sendJson(res, 200, {
              enabled: true,
              schemaReady,
              enginePrimary,
              writeThrough,
              cutoverReady: false,
              json: { sessions: jsonIds.size, messages: jsonMessages },
              mirror: { sessions: 0, messages: 0 },
              missingInMirror: [...jsonIds].slice(0, 50),
              extraInMirror: [],
              blockers: ["mirror_unavailable", ...baseBlockers],
              note: "Mirror unavailable; public GET falls back to JSON.",
            });
          }
          const mirrored = await mirror.listSessions({ limit: 2_000 });
          const mirrorIds = new Set(mirrored.map((s) => s.id).filter(Boolean));
          let mirrorMessages = 0;
          for (const id of mirrorIds) {
            try {
              const msgs = await sessionMirrorStores?.sessions?.getMessages?.(id);
              if (Array.isArray(msgs)) mirrorMessages += msgs.length;
            } catch {
              /* ignore per-session */
            }
          }
          const missingInMirror = [...jsonIds].filter((id) => !mirrorIds.has(id)).slice(0, 50);
          const extraInMirror = [...mirrorIds].filter((id) => !jsonIds.has(id)).slice(0, 50);
          const blockers = [...baseBlockers];
          if (missingInMirror.length) blockers.unshift("mirror_missing_sessions");
          // Ready when enginePrimary on, mirror covers JSON, write-through dual-commit active.
          const cutoverReady = enginePrimary && writeThrough && missingInMirror.length === 0;
          return sendJson(res, 200, {
            enabled: true,
            schemaReady,
            enginePrimary,
            writeThrough,
            cutoverReady,
            json: { sessions: jsonIds.size, messages: jsonMessages },
            mirror: { sessions: mirrorIds.size, messages: mirrorMessages },
            missingInMirror,
            extraInMirror,
            blockers: cutoverReady ? [] : blockers,
            note: cutoverReady
              ? "A4b+A4c: GET prefers engine; approval/rewind pure algorithms on preferred history + dual-commit."
              : "Resync mirror and enable enginePrimary for dual-commit + GET preference.",
          });
        } catch (error) {
          return sendJson(res, 200, {
            enabled: true,
            schemaReady,
            enginePrimary,
            writeThrough,
            cutoverReady: false,
            json: { sessions: jsonIds.size, messages: jsonMessages },
            mirror: { sessions: 0, messages: 0 },
            missingInMirror: [...jsonIds].slice(0, 50),
            extraInMirror: [],
            blockers: ["parity_error", ...baseBlockers],
            message: error?.message ?? "parity_error",
            note: "JSON chat store is UI write path.",
          });
        }
      }

      // Transparent, local-only baseline for Settings. This is intentionally
      // not presented as a turn transcript: project recall, a selected Skill,
      // and a Team role are assembled only when a concrete chat turn starts.
      if (path === "/api/prompt/effective" && req.method === "GET") {
        try {
          const mod = await getEngine();
          if (typeof mod?.buildSystemPromptParts !== "function" || !mod?.TOOL_DESCRIPTIONS) {
            return sendJson(res, 503, { code: "prompt_inspector_unavailable", error: "prompt_inspector_unavailable" });
          }
          const engineConfig = isPlainRecord(config.engine) ? config.engine : {};
          const memory = isPlainRecord(engineConfig.memory) ? engineConfig.memory : {};
          const mcp = isPlainRecord(engineConfig.mcp) ? engineConfig.mcp : {};
          const delegation = isPlainRecord(engineConfig.delegation) ? engineConfig.delegation : {};
          const index = isPlainRecord(memory.index) ? memory.index : {};
          const gbrain = isPlainRecord(memory.gbrain) ? memory.gbrain : {};
          const workspace = typeof config.workspace === "string" && config.workspace.trim()
            ? config.workspace.trim()
            : undefined;
          const profiles = Array.isArray(engineConfig.promptProfiles) ? engineConfig.promptProfiles : [];
          const activePromptProfileId = typeof engineConfig.activePromptProfileId === "string"
            ? engineConfig.activePromptProfileId
            : "";
          const promptProfile = profiles.find((profile) => profile?.id === activePromptProfileId);
          const skillRuntime = await skillsStore.runtimeSkills().catch(() => ({ skills: [] }));
          const skills = Array.isArray(skillRuntime?.skills) ? skillRuntime.skills : [];
          const parts = mod.buildSystemPromptParts({
            workspace,
            hasTools: true,
            availableToolNames: Object.keys(mod.TOOL_DESCRIPTIONS),
            personality: typeof mod.resolvePersonalityText === "function"
              ? mod.resolvePersonalityText({
                  personality: typeof engineConfig.personality === "string" ? engineConfig.personality : "",
                  personalityPresetId: typeof engineConfig.personalityPresetId === "string"
                    ? engineConfig.personalityPresetId
                    : "none",
                })
              : typeof engineConfig.personality === "string"
                ? engineConfig.personality
                : "",
            codingMode: typeof engineConfig.codingMode === "string" ? engineConfig.codingMode : "auto",
            timezone: typeof engineConfig.timezone === "string" ? engineConfig.timezone : undefined,
            promptProfile: typeof promptProfile?.systemPrompt === "string" ? promptProfile.systemPrompt : undefined,
            hasBrainTools: gbrain.mode === "read" || gbrain.mode === "read-write",
            hasBrainWriteTools: gbrain.mode === "read-write",
            hasDecisionTools: Boolean(workspace && memory.ltm?.enabled),
            hasPlanningTools: engineConfig.planning?.enabled !== false,
            hasOpenVikingTools: memory.openviking?.enabled === true,
            hasMemorySearch: Boolean(workspace && index.enabled !== false),
            hasMemoryWriteTools: Boolean(workspace && index.enabled !== false),
            hasMcpTools: mcp.enabled !== false && Array.isArray(mcp.servers) && mcp.servers.length > 0,
            hasDelegation: delegation.enabled !== false,
            skills: skills.map(({ id, name, description }) => ({ id, name, description })),
          });
          const stable = redactSensitiveText(parts?.stable ?? "", runtimeSensitiveValues());
          const volatile = redactSensitiveText(parts?.volatile ?? "", runtimeSensitiveValues());
          return sendJson(res, 200, {
            kind: "baseline",
            version: typeof mod.PROMPT_VERSION === "string" ? mod.PROMPT_VERSION : "unknown",
            codingMode: typeof engineConfig.codingMode === "string" ? engineConfig.codingMode : "auto",
            workspaceSet: Boolean(workspace),
            availableTools: Object.keys(mod.TOOL_DESCRIPTIONS).sort(),
            stable,
            ...(volatile ? { volatile } : {}),
            chars: stable.length + volatile.length,
            omissions: [
              "project_context_and_recall",
              "current_session_messages",
              "per_turn_skill_selection",
              "team_role_assignment",
              "runtime_tool_health",
            ],
          });
        } catch (error) {
          return sendJson(res, 500, {
            code: "prompt_inspector_failed",
            error: redactSensitiveText(error?.message ?? "prompt_inspector_failed", runtimeSensitiveValues()),
          });
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
                  // Pinned truth-gate checks (testDigest frozen at config normalize).
                  ...(Array.isArray(stage.checks) && stage.checks.length
                    ? { checks: stage.checks }
                    : {}),
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

      if (path === "/api/connectors/kiro/organization") {
        if (req.method === "GET") return sendJson(res, 200, kiroOrganizationBroker.snapshot());
      }

      if (path === "/api/connectors/kiro/organization/pool" && req.method === "PATCH") {
        const body = assertOnlyFields(
          await readBody(req),
          new Set(["enabled", "strategy", "sessionAffinity", "expectedGeneration"]),
        );
        const snapshot = await mutateConfig(async () => {
          requireKiroOrganizationGeneration(body.expectedGeneration);
          const current = config.kiroOrganization;
          const nextOrganization = normalizeKiroOrganizationConfig({
            ...current,
            ...(Object.hasOwn(body, "enabled") ? { enabled: body.enabled } : {}),
            ...(Object.hasOwn(body, "strategy") ? { strategy: body.strategy } : {}),
            ...(Object.hasOwn(body, "sessionAffinity") ? { sessionAffinity: body.sessionAffinity } : {}),
          }, { previous: current });
          return commitKiroOrganizationState(nextOrganization, currentKiroOrganizationSecrets());
        });
        return sendJson(res, 200, snapshot);
      }

      if (path === "/api/connectors/kiro/organization/accounts" && req.method === "POST") {
        const body = assertOnlyFields(
          await readBody(req),
          new Set(["account", "credential", "expectedGeneration"]),
        );
        const accountInput = assertOnlyFields(
          body.account,
          KIRO_ORGANIZATION_ACCOUNT_INPUT_FIELDS,
          "kiro_organization_account_field_invalid",
        );
        if (!body.credential) throw kiroOrganizationError("kiro_organization_credential_required");
        requireKiroOrganizationProtectedStorage();
        const credential = normalizeKiroOrganizationAccountSecret(body.credential);
        const snapshot = await mutateConfig(async () => {
          requireKiroOrganizationGeneration(body.expectedGeneration);
          const current = config.kiroOrganization;
          if (current.accounts.length >= MAX_KIRO_ORGANIZATION_ACCOUNTS) {
            throw kiroOrganizationError("kiro_organization_accounts_limit");
          }
          if (current.accounts.some((account) => account.id === accountInput.id)) {
            throw kiroOrganizationError("kiro_organization_account_conflict");
          }
          const nextOrganization = normalizeKiroOrganizationConfig({
            ...current,
            accounts: [...current.accounts, accountInput],
          }, { previous: current });
          const nextOrganizationSecrets = currentKiroOrganizationSecrets();
          nextOrganizationSecrets.set(accountInput.id, credential);
          return commitKiroOrganizationState(nextOrganization, nextOrganizationSecrets);
        });
        return sendJson(res, 201, snapshot);
      }

      const kiroOrganizationAccountMatch = path.match(
        /^\/api\/connectors\/kiro\/organization\/accounts\/([^/]+)(\/(?:verify|models|revoke))?$/,
      );
      if (kiroOrganizationAccountMatch) {
        const accountId = decodeURIComponent(kiroOrganizationAccountMatch[1]);
        const action = kiroOrganizationAccountMatch[2] ?? "";

        if (!action && req.method === "PATCH") {
          const body = assertOnlyFields(
            await readBody(req),
            new Set(["account", "credential", "expectedRevision"]),
          );
          const accountPatch = assertOnlyFields(
            body.account,
            KIRO_ORGANIZATION_ACCOUNT_INPUT_FIELDS,
            "kiro_organization_account_field_invalid",
          );
          if (Object.hasOwn(accountPatch, "id") && accountPatch.id !== accountId) {
            throw kiroOrganizationError("kiro_organization_account_id_immutable");
          }
          const suppliedCredential = Object.hasOwn(body, "credential");
          let credential;
          if (suppliedCredential) {
            requireKiroOrganizationProtectedStorage();
            credential = normalizeKiroOrganizationAccountSecret(body.credential);
          }
          const snapshot = await mutateConfig(async () => {
            const current = config.kiroOrganization;
            const previous = currentKiroOrganizationAccount(accountId);
            requireKiroOrganizationAccountRevision(previous, body.expectedRevision);
            let nextOrganization = normalizeKiroOrganizationConfig({
              ...current,
              accounts: current.accounts.map((account) => account.id === accountId
                ? { ...account, ...accountPatch, id: accountId, revision: account.revision }
                : account),
            }, { previous: current });
            const nextOrganizationSecrets = currentKiroOrganizationSecrets();
            if (suppliedCredential) {
              nextOrganizationSecrets.set(accountId, credential);
              nextOrganization = advanceKiroOrganizationCredentialRevision(
                nextOrganization,
                current,
                accountId,
              );
            }
            return commitKiroOrganizationState(nextOrganization, nextOrganizationSecrets);
          });
          return sendJson(res, 200, snapshot);
        }

        if (!action && req.method === "DELETE") {
          const body = assertOnlyFields(await readBody(req), new Set(["expectedRevision"]));
          const snapshot = await mutateConfig(async () => {
            const current = config.kiroOrganization;
            const previous = currentKiroOrganizationAccount(accountId);
            requireKiroOrganizationAccountRevision(previous, body.expectedRevision);
            // Fence active work before the disk commit. A failed persistence
            // leaves the in-memory account revoked instead of silently active.
            kiroOrganizationBroker.revoke(accountId);
            const nextOrganization = normalizeKiroOrganizationConfig({
              ...current,
              accounts: current.accounts.filter((account) => account.id !== accountId),
            }, { previous: current });
            const nextOrganizationSecrets = currentKiroOrganizationSecrets();
            nextOrganizationSecrets.delete(accountId);
            try {
              const committed = await commitKiroOrganizationState(nextOrganization, nextOrganizationSecrets);
              kiroOrganizationBroker.markRevocationCommitted(accountId, previous.revision);
              return committed;
            } catch (error) {
              forgetKiroOrganizationCredentialInMemory(accountId);
              kiroOrganizationBroker.markRevocationPersistenceFailed(accountId, previous.revision);
              throw error;
            }
          });
          return sendJson(res, 200, snapshot);
        }

        if (action === "/verify" && req.method === "POST") {
          const body = assertOnlyFields(await readBody(req), new Set(["expectedRevision"]));
          const account = currentKiroOrganizationAccount(accountId);
          requireKiroOrganizationAccountRevision(account, body.expectedRevision);
          await kiroOrganizationBroker.verifyAccount(accountId);
          return sendJson(res, 200, kiroOrganizationBroker.snapshot());
        }

        if (action === "/models" && req.method === "POST") {
          assertOnlyFields(await readBody(req), new Set());
          currentKiroOrganizationAccount(accountId);
          return sendJson(res, 200, await kiroOrganizationBroker.discoverModels(accountId));
        }

        if (action === "/revoke" && req.method === "POST") {
          const body = assertOnlyFields(await readBody(req), new Set(["expectedRevision"]));
          const snapshot = await mutateConfig(async () => {
            const current = config.kiroOrganization;
            const previous = currentKiroOrganizationAccount(accountId);
            requireKiroOrganizationAccountRevision(previous, body.expectedRevision);
            kiroOrganizationBroker.revoke(accountId);
            const nextOrganizationSecrets = currentKiroOrganizationSecrets();
            nextOrganizationSecrets.delete(accountId);
            const nextOrganization = advanceKiroOrganizationCredentialRevision(
              normalizeKiroOrganizationConfig(current),
              current,
              accountId,
            );
            try {
              const committed = await commitKiroOrganizationState(nextOrganization, nextOrganizationSecrets);
              kiroOrganizationBroker.markRevocationCommitted(accountId, previous.revision);
              return committed;
            } catch (error) {
              forgetKiroOrganizationCredentialInMemory(accountId);
              kiroOrganizationBroker.markRevocationPersistenceFailed(accountId, previous.revision);
              throw error;
            }
          });
          return sendJson(res, 200, snapshot);
        }
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
        const requiresApiKey = profile.requiresApiKey !== false;
        const credentials = requiresApiKey ? suppliedCredentials : {};
        if (requiresApiKey && !credentials.apiKey) {
          throw new ProviderConfigError("provider_credentials_required");
        }
        const models = await providerDiscovery({
          providerId: profile.id,
          protocol: profile.protocol,
          baseURL: profile.baseURL,
          headers: profile.headers,
          credentials,
          allowBenchmarkNetwork: profile.allowBenchmarkNetwork === true,
        });
        rememberDiscoveredCapabilities({ protocol: profile.protocol, baseURL: profile.baseURL, models });
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
            const provider = validateProviderInput(input, {
              creating: true,
              verifyLiveCapabilities: liveCapabilityVerifier(undefined),
            });
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
            const activateModelId = body.modelId ?? input.model ?? added.provider.models[0]?.id;
            if (shouldActivateProviderAsDefault(nextConfig, nextSecrets, added.provider.id, activateModelId, body)) {
              const candidate = selectExistingProviderModel(nextConfig, added.provider.id, activateModelId);
              try {
                requireReadyProviderModel(
                  candidate,
                  nextSecrets,
                  candidate.activeProviderId,
                  candidate.activeModelId,
                );
                nextConfig = candidate;
              } catch (error) {
                if (body.useAsDefault === true || body.activate === true) throw error;
              }
            }
            nextConfig = reconcileReadyModelAssignments(nextConfig, nextSecrets);
            await saveConfig(nextConfig, nextSecrets);
            config = nextConfig;
            secrets = nextSecrets;
            rebindUnreadyIdleSessions(config, secrets);
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
          const credentials = existing.requiresApiKey
            ? getProviderAccountCredentials(secrets, providerId, accountId)
            : {};
          if (existing.requiresApiKey && !hasStoredProviderCredentials(existing, credentials)) {
            throw new ProviderConfigError("provider_credentials_required");
          }
          const models = await providerDiscovery({
            providerId,
            protocol: existing.protocol,
            baseURL: existing.baseURL,
            headers: existing.headers,
            credentials,
          });
          rememberDiscoveredCapabilities({ protocol: existing.protocol, baseURL: existing.baseURL, models });
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
          const credentials = existing.requiresApiKey ? secrets.providers[providerId] ?? {} : {};
          if (existing.requiresApiKey && !hasStoredProviderCredentials(existing, credentials)) {
            throw new ProviderConfigError("provider_credentials_required");
          }
          const models = await providerDiscovery({
            providerId,
            protocol: existing.protocol,
            baseURL: existing.baseURL,
            headers: existing.headers,
            credentials,
            allowBenchmarkNetwork: Boolean(body && typeof body === "object" && !Array.isArray(body) && body.allowBenchmarkNetwork === true),
          });
          rememberDiscoveredCapabilities({ protocol: existing.protocol, baseURL: existing.baseURL, models });
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
              let nextConfig = config;
              // Pasting a key on a non-default ready profile while the active
              // stub still has no credentials should make that profile the default.
              if (shouldActivateProviderAsDefault(nextConfig, nextSecrets, providerId, existing.models[0]?.id, {})) {
                const candidate = selectExistingProviderModel(nextConfig, providerId, existing.models[0]?.id);
                try {
                  requireReadyProviderModel(
                    candidate,
                    nextSecrets,
                    candidate.activeProviderId,
                    candidate.activeModelId,
                  );
                  nextConfig = candidate;
                } catch {
                  /* keep previous active if candidate still not ready */
                }
              }
              await saveConfig(nextConfig, nextSecrets);
              config = nextConfig;
              secrets = nextSecrets;
              invalidateProviderRuntime(providerId);
              rebindUnreadyIdleSessions(config, secrets);
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
            const updatedProvider = validateProviderInput({ ...existing, ...patch }, {
              providerId,
              verifyLiveCapabilities: liveCapabilityVerifier(existing),
            });
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
            const activateModelId = body.modelId ?? updated.provider.models[0]?.id;
            if (shouldActivateProviderAsDefault(nextConfig, nextSecrets, providerId, activateModelId, body)) {
              const candidate = selectExistingProviderModel(nextConfig, providerId, activateModelId);
              try {
                requireReadyProviderModel(
                  candidate,
                  nextSecrets,
                  candidate.activeProviderId,
                  candidate.activeModelId,
                );
                nextConfig = candidate;
              } catch (error) {
                if (body.useAsDefault === true || body.activate === true) throw error;
              }
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
            rebindUnreadyIdleSessions(config, secrets);
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
            await saveConfigWithWorkspace({
              previousWorkspace: typeof config.workspace === "string" ? config.workspace : "",
              nextWorkspace: nextConfig.workspace,
              skillsStore,
              saveConfig: () => saveConfig(nextConfig, secrets),
            });
            config = nextConfig;
            return publicGatewayConfig(config, secrets);
          });
          // Same OOB path as setConfig({ workspace }) — DBs before UI continues.
          await bootstrapLocalDatabases("choose-folder");
          snapshot = publicConfig();
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

      // Optional Skills curator (default OFF). Proposal-first; LLM patches never auto-applied.
      if (path === "/api/skills/curator/scan" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const engineSkills = isPlainRecord(config.engine?.skills) ? config.engine.skills : {};
        const curatorCfg = normalizeSkillsCuratorConfig(
          isPlainRecord(engineSkills.curator) ? engineSkills.curator : {},
        );
        // force=true is for offline/tests: always propose-only (never apply_safe without opt-in).
        const force = body?.force === true;
        const enabled = curatorCfg.enabled || force;
        if (!enabled) {
          return sendJson(res, 400, { code: "curator_disabled", error: "curator_disabled" });
        }
        let applyMode = body?.applyMode === "apply_safe" || body?.applyMode === "propose"
          ? body.applyMode
          : undefined;
        if (force && !curatorCfg.enabled) applyMode = "propose";
        const listed = await skillsStore.list();
        let skills = listed;
        let model;
        let generateTextFn;
        let modelSourceUsed = "none";
        if (curatorCfg.useLlm) {
          // Load content for owned skills (bounded) so the LLM can draft patches.
          const owned = listed.filter((s) => s.owned).slice(0, Math.max(curatorCfg.maxLlmSkills * 3, 12));
          /** @type {Map<string, object>} */
          const enriched = new Map();
          for (const s of owned) {
            try {
              const full = await skillsStore.get(s.id);
              enriched.set(s.id, { ...s, content: full.content });
            } catch {
              enriched.set(s.id, s);
            }
          }
          skills = listed.map((s) => enriched.get(s.id) || s);

          try {
            const mod = await getEngine();
            if (typeof mod?.buildModel === "function") {
              const source = curatorCfg.modelSource;
              /** @type {object | undefined} */
              let target;
              if (source === "worker") {
                target = workerRuntimeTarget(undefined);
                if (target) modelSourceUsed = "worker";
              }
              if (!target && (source === "session" || source === "worker")) {
                try {
                  const targets = privateRuntimeTargetsForConfig(
                    config,
                    secrets,
                    config.activeProviderId,
                    config.activeModelId,
                    { fallbackToDefault: true },
                  );
                  target = targets[0];
                  if (target) modelSourceUsed = "session";
                } catch {
                  target = undefined;
                }
              }
              if (!target) {
                try {
                  const targets = privateRuntimeTargetsForConfig(
                    config,
                    secrets,
                    config.activeProviderId,
                    config.activeModelId,
                    { fallbackToDefault: true },
                  );
                  target = targets[0];
                  if (target) modelSourceUsed = "default";
                } catch {
                  target = undefined;
                }
              }
              if (target) {
                model = mod.buildModel({
                  protocol: target.protocol,
                  baseURL: target.baseURL,
                  apiKey: typeof target.apiKey === "string" ? target.apiKey : "",
                  credentials: target.credentials ?? {},
                  model: target.model,
                  ...(target.headers ? { headers: target.headers } : {}),
                });
                const ai = await import("ai");
                generateTextFn = ai.generateText;
              }
            }
          } catch {
            model = undefined;
            modelSourceUsed = "none";
          }
        }
        const result = await curateSkills({
          dataDir,
          skills,
          skillsStore,
          config: { ...curatorCfg, enabled: true },
          ...(applyMode ? { applyModeOverride: applyMode } : {}),
          ...(model ? { model } : {}),
          ...(generateTextFn ? { generateText: generateTextFn } : {}),
        });
        return sendJson(res, result.ok ? 200 : 400, { ...result, modelSource: modelSourceUsed });
      }

      if (path === "/api/skills/curator/proposals" && req.method === "GET") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));
        const proposals = await listSkillsCuratorProposals(dataDir, { limit });
        return sendJson(res, 200, {
          proposals: proposals.map((p) => ({
            fileName: p.fileName,
            path: p.path,
            via: p.via,
            applyMode: p.applyMode,
            status: p.status,
            at: p.at,
            applied: p.applied,
            proposalCount: p.proposalCount,
            preview: (p.proposals || []).slice(0, 8).map((x) => ({
              id: x.id,
              skillId: x.skillId,
              skillName: x.skillName,
              action: x.action,
              kind: x.kind,
              reason: x.reason,
              detail: x.detail,
              owned: x.owned,
              patchSummary: x.patchSummary,
              suggestedDescription: x.suggestedDescription
                ? String(x.suggestedDescription).slice(0, 280)
                : undefined,
              hasContentPatch: Boolean(x.suggestedContent),
            })),
          })),
        });
      }

      if (path === "/api/skills/curator/proposals/apply" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const file = typeof body?.fileName === "string" && body.fileName
          ? body.fileName
          : typeof body?.path === "string"
            ? body.path
            : "";
        if (!file) return sendJson(res, 400, { code: "file_required", error: "file_required" });
        const result = await applyStoredSkillsCuratorProposal(
          dataDir,
          file,
          "apply_safe",
          skillsStore,
        );
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // Wave C1: Skill sleep — trajectory harvest → proposal-only skill diffs.
      if (path === "/api/skills/sleep" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const engineSkills = isPlainRecord(config.engine?.skills) ? config.engine.skills : {};
        const sleepCfg = normalizeSkillsSleepConfig(
          isPlainRecord(engineSkills.sleep) ? engineSkills.sleep : {},
        );
        if (!sleepCfg.enabled && body?.force !== true) {
          return sendJson(res, 400, { code: "sleep_disabled", error: "sleep_disabled" });
        }
        // Build digests from recent sessions (JSON SoT).
        const limit = Math.min(
          sleepCfg.maxTrajectories,
          Math.max(1, Number(body?.limit) || sleepCfg.maxTrajectories),
        );
        let sessions = [];
        try {
          sessions = await listSessionsForApi({ includeArchived: true });
        } catch {
          sessions = [];
        }
        const trajectories = [];
        for (const session of (sessions || []).slice(0, limit)) {
          try {
            const messages = typeof store.getMessages === "function"
              ? store.getMessages(session.id)
              : [];
            const full = typeof store.getSession === "function"
              ? store.getSession(session.id)
              : session;
            const skillIds = Array.isArray(full?.skillIds)
              ? full.skillIds
              : Array.isArray(session?.skillIds)
                ? session.skillIds
                : [];
            trajectories.push(digestMessagesToTrajectory(messages, {
              sessionId: session.id,
              status: full?.status || session?.status,
              skillIds,
            }));
          } catch {
            /* skip corrupt session */
          }
        }
        // Prefer body-supplied digests when tests/offline inject them.
        if (Array.isArray(body?.trajectories) && body.trajectories.length) {
          trajectories.length = 0;
          for (const t of body.trajectories.slice(0, limit)) {
            if (t && typeof t === "object") trajectories.push(t);
          }
        }
        const listed = await skillsStore.list();
        /** @type {Map<string, object>} */
        const enriched = new Map();
        for (const s of listed.filter((x) => x.owned).slice(0, 40)) {
          try {
            const full = await skillsStore.get(s.id);
            enriched.set(s.id, { ...s, content: full.content });
          } catch {
            enriched.set(s.id, s);
          }
        }
        const skills = listed.map((s) => enriched.get(s.id) || s);
        const result = await runSkillSleep({
          dataDir,
          trajectories,
          skills,
          config: { ...sleepCfg, enabled: true },
        });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // Wave C2: curated skill packs (opt-in roots).
      if (path === "/api/skills/packs" && req.method === "GET") {
        const packs = await listSkillPacks(skillsStore);
        return sendJson(res, 200, { packs, catalog: BUILTIN_SKILL_PACKS });
      }
      if (path === "/api/skills/packs/enable" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const packId = typeof body?.packId === "string" ? body.packId : "";
        try {
          const result = await enableSkillPack(skillsStore, packId);
          return sendJson(res, 200, {
            ...result,
            skills: await skillsStore.list(),
            roots: await skillsStore.roots(),
            packs: await listSkillPacks(skillsStore),
          });
        } catch (error) {
          return sendJson(res, 400, {
            code: error?.code || "pack_enable_failed",
            error: error?.message || "pack_enable_failed",
          });
        }
      }
      if (path === "/api/skills/packs/disable" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const packId = typeof body?.packId === "string" ? body.packId : "";
        try {
          const result = await disableSkillPack(skillsStore, packId);
          return sendJson(res, 200, {
            ...result,
            skills: await skillsStore.list(),
            roots: await skillsStore.roots(),
            packs: await listSkillPacks(skillsStore),
          });
        } catch (error) {
          return sendJson(res, 400, {
            code: error?.code || "pack_disable_failed",
            error: error?.message || "pack_disable_failed",
          });
        }
      }

      if (path === "/api/skills/curator/proposals/apply-one" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const skillId = typeof body?.skillId === "string" ? body.skillId : "";
        const action = body?.action === "enable"
          || body?.action === "disable"
          || body?.action === "apply_patch"
          || body?.action === "suggest_patch"
          ? body.action
          : "";
        if (!skillId || !action) {
          return sendJson(res, 400, { code: "invalid_proposal", error: "skillId and action required" });
        }
        try {
          // For LLM patches, resolve draft from stored proposal file when not inlined.
          let suggestedContent = typeof body?.suggestedContent === "string" ? body.suggestedContent : undefined;
          let suggestedDescription = typeof body?.suggestedDescription === "string"
            ? body.suggestedDescription
            : undefined;
          if ((action === "apply_patch" || action === "suggest_patch")
            && !suggestedContent && !suggestedDescription
            && typeof body?.fileName === "string" && body.fileName
            && typeof body?.proposalId === "string" && body.proposalId) {
            const listed = await listSkillsCuratorProposals(dataDir, { limit: 100 });
            const row = listed.find((p) => p.fileName === basename(body.fileName));
            const hit = (row?.proposals || []).find((x) => x.id === body.proposalId && x.skillId === skillId);
            if (hit) {
              if (typeof hit.suggestedContent === "string") suggestedContent = hit.suggestedContent;
              if (typeof hit.suggestedDescription === "string") suggestedDescription = hit.suggestedDescription;
            }
          }
          const result = await applySingleSkillsProposal(skillsStore, {
            skillId,
            action,
            ...(suggestedContent ? { suggestedContent } : {}),
            ...(suggestedDescription ? { suggestedDescription } : {}),
          });
          return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return sendJson(res, 400, {
            code: error?.code ?? "apply_failed",
            error: error?.message ?? "apply_failed",
          });
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
        if (!skillRootMatch[2] && req.method === "DELETE") {
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

      if (path === "/api/import/transcript" && req.method === "POST") {
        assertGatewayAcceptingMutations();
        const body = await readBody(req);
        const fileName = typeof body.fileName === "string" && body.fileName.trim()
          ? body.fileName.trim().slice(0, 260)
          : "import.bin";
        let bytes;
        if (typeof body.contentBase64 === "string" && body.contentBase64.length) {
          try {
            bytes = Buffer.from(body.contentBase64, "base64");
          } catch {
            return sendJson(res, 400, { code: "import_invalid_input", error: "invalid contentBase64" });
          }
        } else {
          return sendJson(res, 400, { code: "import_invalid_input", error: "contentBase64 required" });
        }
        if (bytes.byteLength > 32 * 1024 * 1024) {
          return sendJson(res, 413, { code: "import_payload_too_large", error: "import_payload_too_large" });
        }
        const workspace = config.workspace;
        if (typeof workspace !== "string" || !workspace.trim()) {
          return sendJson(res, 400, { code: "import_workspace_invalid", error: "workspace not configured" });
        }
        const options = body.options && typeof body.options === "object" ? body.options : {};
        const ltmDir = typeof config.engine?.memory?.ltm?.dir === "string"
          ? config.engine.memory.ltm.dir
          : (config.workspace ? join(config.workspace, "ltm") : undefined);
        try {
          const mod = await getEngine();
          if (typeof mod?.orchestrateImport !== "function") {
            return sendJson(res, 503, { code: "import_unavailable", error: "import_unavailable" });
          }
          const createSessionFlag = options.createSession !== false;
          const result = await mod.orchestrateImport(
            {
              fileName,
              bytes: new Uint8Array(bytes),
            },
            {
              workspace,
              ltmDir: options.writeLtm === false ? undefined : ltmDir,
              adapterId: typeof body.adapterId === "string" ? body.adapterId : undefined,
              writeHandoff: options.writeHandoff !== false,
              writeLtm: options.writeLtm !== false,
              createSession: createSessionFlag,
              includeTranscriptExcerpt: options.includeTranscriptExcerpt === true,
              dedupe: options.dedupe !== false,
              dedupeMode: options.dedupeMode === "refresh" ? "refresh" : "skip",
              sessionTitle: typeof options.sessionTitle === "string" ? options.sessionTitle : undefined,
              reindex: options.reindex !== false,
              index: config.engine?.memory?.index && typeof config.engine.memory.index === "object"
                ? config.engine.memory.index
                : undefined,
            },
            {
              createSeedSession: createSessionFlag
                ? async ({ title, seedText }) => {
                  const session = createSession({ title, source: "import" });
                  const safe = redactSensitiveText(seedText, runtimeSensitiveValues());
                  store.appendMessage(session.id, {
                    role: "user",
                    content: safe.slice(0, 32_000),
                  });
                  store.upsertSession({
                    id: session.id,
                    title: session.title || title,
                    updatedAt: new Date().toISOString(),
                  });
                  await store.flush();
                  const committed = await commitSessionToEngine(session.id);
                  if (!committed.ok && sessionMirrorEnginePrimary()) {
                    throw new Error(committed.error ?? "engine_mirror_write_failed");
                  }
                  return { sessionId: session.id };
                }
                : undefined,
            },
          );
          return sendJson(res, 200, {
            report: result.report,
            handoffId: result.report.handoffId,
            sessionId: result.report.sessionId,
          });
        } catch (error) {
          const code = error && typeof error === "object" && typeof error.code === "string"
            ? error.code
            : "import_failed";
          const status = code === "import_payload_too_large"
            ? 413
            : code === "import_duplicate"
              ? 409
              : code === "import_format_unsupported" || code === "import_format_ambiguous"
                || code === "import_adapter_parse_failed" || code === "import_transcript_empty"
                || code === "import_invalid_input" || code === "import_workspace_invalid"
                ? 422
                : 400;
          return sendJson(res, status, {
            code,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (path === "/api/sessions") {
        if (req.method === "GET") {
          const archivedParam = url.searchParams.get("archived");
          const archivedOnly = archivedParam === "1" || archivedParam === "only" || archivedParam === "true";
          const includeArchived = archivedParam === "all";
          const sessions = await listSessionsForApi({ archivedOnly, includeArchived });
          return sendJson(res, 200, {
            sessions,
            ...(sessionMirrorEnginePrimary() ? { source: "engine_primary" } : { source: "json" }),
            ...(archivedOnly ? { filter: "archived" } : includeArchived ? { filter: "all" } : { filter: "active" }),
          });
        }
        if (req.method === "POST") {
          const session = createSession();
          const commit = await commitSessionToEngine(session.id);
          if (!commit.ok && sessionMirrorEnginePrimary()) {
            store.removeSession(session.id);
            return sendJson(res, 503, {
              code: "engine_mirror_write_failed",
              error: commit.error ?? "engine_mirror_write_failed",
            });
          }
          return sendJson(res, 200, { id: session.id, session });
        }
      }

      // Fork chat into a new session (lineageKind=branch). Parent history untouched.
      const forkMatch = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
      if (forkMatch && req.method === "POST") {
        const parentId = decodeURIComponent(forkMatch[1]);
        if (!store.getSession(parentId)) {
          return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
        }
        if (controllers.has(parentId) || sessionReservations.has(parentId)) {
          return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
        }
        assertGatewayAcceptingMutations();
        const body = await readBody(req).catch(() => ({}));
        const messageId = typeof body?.messageId === "string" && body.messageId.trim()
          ? body.messageId.trim()
          : undefined;
        try {
          const result = store.forkSession(parentId, { messageId });
          if (!result?.session) {
            return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
          }
          await store.flush();
          const commit = await commitSessionToEngine(result.session.id);
          if (!commit.ok && sessionMirrorEnginePrimary()) {
            // Roll back JSON + mirror so enginePrimary list does not ghost the fork.
            try {
              await removeGatewaySessionFromMirror(result.session.id);
            } catch {
              /* best-effort */
            }
            store.removeSession(result.session.id);
            await store.flush().catch(() => {});
            return sendJson(res, 503, {
              code: "engine_mirror_write_failed",
              error: commit.error ?? "engine_mirror_write_failed",
            });
          }
          try {
            emitTo(parentId, {
              type: "session.forked",
              payload: {
                parent_session_id: parentId,
                session_id: result.session.id,
                message_count: result.messageCount,
              },
            });
          } catch {
            /* SSE notify is best-effort */
          }
          return sendJson(res, 200, {
            id: result.session.id,
            session: result.session,
            messageCount: result.messageCount,
            ...(sessionMirrorEnginePrimary() ? { engineCommitted: true } : {}),
          });
        } catch (error) {
          const code = error?.code ?? "fork_failed";
          const status = code === "fork_message_not_found" || code === "fork_message_not_user"
            ? 400
            : code === "fork_id_exists"
              ? 409
              : 500;
          return sendJson(res, status, {
            code,
            error: error?.message ?? "fork_failed",
          });
        }
      }

      // View all file changes across the session (autopilot + supervised).
      const changesMatch = path.match(/^\/api\/sessions\/([^/]+)\/changes$/);
      if (changesMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(changesMatch[1]);
        if (!store.getSession(sessionId)) {
          return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
        }
        const changes = collectSessionFileChanges(store.getMessages(sessionId));
        return sendJson(res, 200, { sessionId, changes, count: changes.length });
      }

      // Revert all agent file mutations in the session (snapshot restore).
      const revertAllMatch = path.match(/^\/api\/sessions\/([^/]+)\/revert-all$/);
      if (revertAllMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(revertAllMatch[1]);
        if (!store.getSession(sessionId)) {
          return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
        }
        await releaseFinalizedTurn(sessionId);
        if (controllers.has(sessionId) || sessionReservations.has(sessionId)) {
          return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
        }
        assertGatewayAcceptingMutations();
        const changes = collectSessionFileChanges(store.getMessages(sessionId));
        const snapshotIds = [];
        const seen = new Set();
        for (const c of changes) {
          if (c.snapshotId && !seen.has(c.snapshotId)) {
            seen.add(c.snapshotId);
            snapshotIds.push(c.snapshotId);
          }
        }
        let restored = { restoredSnapshots: 0, restoredFiles: 0 };
        if (snapshotIds.length && config.workspace) {
          try {
            const fileTransaction = await beginSnapshotRestore({
              workspace: config.workspace,
              snapshotIds: [...snapshotIds].reverse(),
            });
            restored = fileTransaction.result;
            fileTransaction.commit();
          } catch (error) {
            if (error instanceof SessionCheckpointError) {
              return sendJson(res, 409, { code: error.code, error: error.code });
            }
            return sendJson(res, 500, {
              code: "revert_all_failed",
              error: error?.message ?? "revert_all_failed",
            });
          }
        }
        // Clear any pending supervised review after full revert.
        for (const message of store.getMessages(sessionId)) {
          if (message?.fileReview?.status === "pending") {
            store.updateMessage(sessionId, message.id, {
              turnStatus: "interrupted",
              fileReview: {
                ...message.fileReview,
                status: "rejected",
                files: (message.fileReview.files || []).map((f) => ({ ...f, status: "rejected" })),
                resolvedAt: new Date().toISOString(),
              },
            });
          }
        }
        await store.flush();
        await commitSessionToEngine(sessionId);
        emitTo(sessionId, {
          type: "session.reverted",
          payload: { session_id: sessionId, ...restored, changeCount: changes.length },
        });
        return sendJson(res, 200, { ok: true, ...restored, changeCount: changes.length });
      }

      // Supervised file review: accept/reject all, per-file, or per-hunk.
      const fileReviewMatch = path.match(/^\/api\/sessions\/([^/]+)\/file-review$/);
      if (fileReviewMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(fileReviewMatch[1]);
        if (!store.getSession(sessionId)) {
          return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
        }
        await releaseFinalizedTurn(sessionId);
        if (controllers.has(sessionId) || sessionReservations.has(sessionId)) {
          return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
        }
        const body = await readBody(req);
        assertGatewayAcceptingMutations();
        const messages = store.getMessages(sessionId);
        let target = null;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i];
          if (
            message?.role === "assistant"
            && (message?.fileReview?.status === "pending" || message?.fileReview?.status === "partial")
          ) {
            target = message;
            break;
          }
        }
        if (!target) {
          return sendJson(res, 404, { code: "file_review_not_found", error: "file_review_not_found" });
        }
        const review = target.fileReview;
        // Normalize legacy entries missing per-file status.
        const normalized = {
          ...review,
          files: (Array.isArray(review.files) ? review.files : []).map((f) => ({
            ...f,
            status: f.status === "accepted" || f.status === "rejected" ? f.status : "pending",
          })),
        };

        let nextFiles = normalized.files.map((f) => ({ ...f }));
        let pathDecisions = [];
        let usedHunks = false;

        if (Array.isArray(body.files) && body.files.length) {
          // 1) Per-hunk decisions (no shared-snapshot auto-link).
          for (const entry of body.files) {
            if (!entry || typeof entry.path !== "string") continue;
            if (!Array.isArray(entry.hunks) || !entry.hunks.length) continue;
            usedHunks = true;
            const key = entry.path.replaceAll("\\", "/");
            const idx = nextFiles.findIndex(
              (f) => f.status === "pending" && String(f.path ?? "").replaceAll("\\", "/") === key,
            );
            if (idx < 0) continue;
            const hunkDecisions = entry.hunks
              .filter((h) => h && typeof h.id === "string")
              .map((h) => ({ id: h.id, accept: h.accept === true }));
            nextFiles[idx] = applyHunkDecisionsToFile(nextFiles[idx], hunkDecisions);
          }
          // 2) Path-level accept/reject (links shared snapshotId).
          pathDecisions = body.files
            .filter((f) => f && typeof f.path === "string" && typeof f.accept === "boolean" && !Array.isArray(f.hunks))
            .map((f) => ({ path: f.path, accept: f.accept === true }));
          if (pathDecisions.length) {
            const afterPaths = applyFileReviewDecisions(
              { ...normalized, files: nextFiles },
              pathDecisions,
            );
            nextFiles = afterPaths.files;
          }
        } else if (typeof body.accept === "boolean") {
          pathDecisions = nextFiles
            .filter((f) => f.status === "pending")
            .map((f) => ({ path: f.path, accept: body.accept }));
          const afterPaths = applyFileReviewDecisions(
            { ...normalized, files: nextFiles },
            pathDecisions,
          );
          nextFiles = afterPaths.files;
        } else {
          return sendJson(res, 400, { code: "file_review_invalid", error: "file_review_invalid" });
        }

        if (!usedHunks && !pathDecisions.length && !(Array.isArray(body.files) && body.files.some((f) => f?.hunks?.length))) {
          return sendJson(res, 400, { code: "file_review_invalid", error: "file_review_invalid" });
        }

        const nextReview = withAggregatedReview(normalized, nextFiles);

        // Filesystem effects for newly decided files this request.
        /** @type {Array<{ snapshotId: string, path: string }>} */
        const pathRestores = [];
        /** @type {typeof nextFiles} */
        const selective = [];
        for (let i = 0; i < nextFiles.length; i += 1) {
          const prev = normalized.files[i];
          const next = nextFiles[i];
          if (!prev || !next || prev.status !== "pending" || next.status === "pending") continue;
          if (next.status === "rejected" && next.snapshotId) {
            pathRestores.push({ snapshotId: next.snapshotId, path: next.path });
          } else if (needsSelectiveHunkApply(next) && next.snapshotId) {
            selective.push(next);
          }
        }

        if (config.workspace && (pathRestores.length || selective.length)) {
          try {
            // Group path restores by snapshotId.
            const bySnap = new Map();
            for (const row of pathRestores) {
              const list = bySnap.get(row.snapshotId) ?? [];
              list.push(row.path);
              bySnap.set(row.snapshotId, list);
            }
            for (const [snapshotId, relPaths] of bySnap) {
              await restoreSnapshotPaths({
                workspace: config.workspace,
                snapshotId,
                relPaths,
              });
            }
            for (const file of selective) {
              const pre = await readSnapshotRelativeFile({
                workspace: config.workspace,
                snapshotId: file.snapshotId,
                relPath: file.path,
              });
              const nextText = applyHunksToOldText(pre.text, file.diffOps, file.hunks);
              await writeWorkspaceRelativeFile({
                workspace: config.workspace,
                relPath: file.path,
                text: nextText,
              });
            }
          } catch (error) {
            if (error instanceof SessionCheckpointError) {
              return sendJson(res, 409, { code: error.code, error: error.code });
            }
            return sendJson(res, 500, {
              code: "file_review_restore_failed",
              error: error?.message ?? "file_review_restore_failed",
            });
          }
        }

        const done = nextReview.status !== "pending";
        store.updateMessage(sessionId, target.id, {
          turnStatus: done
            ? (nextReview.status === "rejected" ? "interrupted" : "complete")
            : "awaiting_file_review",
          fileReview: nextReview,
        });
        await store.flush();
        await commitSessionToEngine(sessionId);
        emitTo(sessionId, {
          type: "file_review.resolved",
          payload: {
            session_id: sessionId,
            message_id: target.id,
            status: nextReview.status,
            files: nextReview.files,
            done,
          },
        });
        return sendJson(res, 200, {
          ok: true,
          done,
          messageId: target.id,
          fileReview: store.getMessage(sessionId, target.id)?.fileReview,
        });
      }

      const approvalMatch = path.match(/^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(approvalMatch[1]);
        const approvalId = decodeURIComponent(approvalMatch[2]);
        if (!store.getSession(sessionId)) {
          return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
        }
        await releaseFinalizedTurn(sessionId);
        if (controllers.has(sessionId) || sessionReservations.has(sessionId)) {
          return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
        }
        const reservationToken = Symbol("approval");
        sessionReservations.set(sessionId, reservationToken);
        let continuationStarted = false;
        try {
          const body = await readBody(req);
          assertGatewayAcceptingMutations();
          const promoteAlways = body.always === true || body.promote === true || body.scope === "always";
          let resolved;
          let promotedRule = null;
          try {
            // Prefer engine-backed history when primary; pure algorithm + dual-write.
            const loaded = await loadMessagesForMutation(sessionId);
            const pure = resolveApprovalInMessages(loaded.messages, approvalId, {
              approved: body.approved,
              reason: typeof body.reason === "string" ? body.reason : "",
            });
            await persistMutatedMessages(sessionId, pure.messages);
            resolved = {
              approval: pure.approval,
              messageId: pure.messageId,
              ready: pure.ready,
              modelParams: pure.modelParams,
              source: loaded.source,
            };
            // Session-scoped allow-once for protected write targets (subsequent turns).
            noteProtectedPathAllowOnce(sessionId, pure.approval);

            // Promote decision to a durable exact permission rule (Hermes always allow/deny).
            if (
              promoteAlways
              && pure.approval
              && (pure.approval.status === "approved" || pure.approval.status === "denied")
            ) {
              const action = pure.approval.status === "approved" ? "allow" : "deny";
              const candidate = permissionRuleFromApproval(
                pure.approval.name,
                pure.approval.args,
                action,
              );
              if (candidate) {
                await mutateConfig(async () => {
                  const engine = isPlainRecord(config.engine) ? { ...config.engine } : {};
                  const permissions = isPlainRecord(engine.permissions)
                    ? { ...engine.permissions }
                    : {};
                  const rules = Array.isArray(permissions.rules) ? permissions.rules : [];
                  permissions.rules = mergePermissionRule(rules, candidate);
                  engine.permissions = permissions;
                  const nextConfig = { ...config, engine };
                  await saveConfig(nextConfig, secrets);
                  config = nextConfig;
                  return publicGatewayConfig(config, secrets);
                });
                promotedRule = candidate;
              }
            }
          } catch (error) {
            if (error?.code === "engine_mirror_write_failed") {
              return sendJson(res, 503, {
                code: "engine_mirror_write_failed",
                error: error.message ?? "engine_mirror_write_failed",
              });
            }
            if (error instanceof SessionMutationError || error instanceof SessionApprovalError) {
              const code = error.code || "approval_error";
              const status = code === "approval_not_found" ? 404 : 409;
              return sendJson(res, status, { code, error: code });
            }
            throw error;
          }
          emitTo(sessionId, {
            type: "approval.resolved",
            payload: {
              approval_id: resolved.approval.approvalId,
              tool_call_id: resolved.approval.toolCallId,
              approved: resolved.approval.status === "approved",
              ...(resolved.approval.decisionReason ? { reason: resolved.approval.decisionReason } : {}),
              ...(resolved.approval.consumedAt ? { consumed: true } : {}),
              ...(promotedRule ? { promoted: true, rule: promotedRule } : {}),
            },
          });
          assertGatewayAcceptingMutations();
          if (!resolved.ready) {
            return sendJson(res, 200, {
              status: "pending",
              approval: resolved.approval,
              ...(promotedRule ? { promotedRule } : {}),
              ...(sessionMirrorEnginePrimary()
                ? { engineCommitted: true, mutationSource: resolved.source }
                : {}),
            });
          }

          continuationStarted = true;
          sendJson(res, 200, {
            status: "streaming",
            approval: resolved.approval,
            ...(promotedRule ? { promotedRule } : {}),
            ...(sessionMirrorEnginePrimary()
              ? { engineCommitted: true, mutationSource: resolved.source }
              : {}),
          });
          void runReservedPrompt(sessionId, "", resolved.modelParams, undefined, { appendUser: false })
            .finally(() => {
              if (sessionReservations.get(sessionId) === reservationToken) {
                sessionReservations.delete(sessionId);
              }
            });
          return;
        } finally {
          if (!continuationStarted && sessionReservations.get(sessionId) === reservationToken) {
            sessionReservations.delete(sessionId);
          }
        }
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/messages|\/rewind)?$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        if (sessionMatch[2] === "/messages" && req.method === "GET") {
          const messages = await getMessagesForApi(id);
          return sendJson(res, 200, {
            session_id: id,
            messages: publicStoredMessages(messages),
            ...(sessionMirrorEnginePrimary() ? { source: "engine_primary" } : { source: "json" }),
          });
        }
        if (sessionMatch[2] === "/rewind" && req.method === "POST") {
          await releaseFinalizedTurn(id);
          if (controllers.has(id) || sessionReservations.has(id)) {
            return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
          }
          const reservationToken = Symbol("rewind");
          sessionReservations.set(id, reservationToken);
          try {
            const body = await readBody(req);
            const messageId = String(body.messageId ?? "");
            if (!isSessionMessageId(messageId)) {
              return sendJson(res, 400, { code: "message_id_invalid", error: "message_id_invalid" });
            }
            // Pure plan on preferred message list (engine when primary + caught up).
            const loaded = await loadMessagesForMutation(id);
            const plan = planRewindInMessages(loaded.messages, messageId, store.getSession(id));
            if (!plan) return sendJson(res, 404, { code: "message_not_found", error: "message_not_found" });
            plan.sessionId = id;
            let restored = { restoredSnapshots: 0, restoredFiles: 0 };
            let fileTransaction = null;
            try {
              if (plan.workspace || plan.snapshotIds.length) {
                if (!config.workspace || !plan.workspace) {
                  throw new SessionCheckpointError("checkpoint_workspace_changed");
                }
                const currentWorkspace = await realpath(config.workspace)
                  .catch(() => { throw new SessionCheckpointError("checkpoint_workspace_invalid"); });
                if (currentWorkspace !== plan.workspace) {
                  throw new SessionCheckpointError("checkpoint_workspace_changed");
                }
              }
              if (plan.snapshotIds.length) {
                fileTransaction = await beginSnapshotRestore({
                  workspace: plan.workspace,
                  snapshotIds: [...plan.snapshotIds].reverse(),
                });
                restored = fileTransaction.result;
              }
            } catch (error) {
              if (error instanceof SessionCheckpointError) {
                return sendJson(res, 409, { code: error.code, error: error.code });
              }
              throw error;
            }
            const truncated = commitRewindInMessages(loaded.messages, plan);
            if (!truncated.ok) {
              await fileTransaction?.rollback();
              return sendJson(res, 409, { code: "session_changed", error: "session_changed" });
            }
            try {
              await persistMutatedMessages(id, truncated.messages);
            } catch (error) {
              await fileTransaction?.rollback();
              if (error?.code === "engine_mirror_write_failed") {
                return sendJson(res, 503, {
                  code: "engine_mirror_write_failed",
                  error: error.message ?? "engine_mirror_write_failed",
                });
              }
              // JSON flush failed — try legacy rollback if we still had original on JSON.
              try {
                if (Array.isArray(plan.originalMessages)) {
                  store.replaceMessages(id, plan.originalMessages);
                  await store.flush();
                }
              } catch {
                /* best effort */
              }
              return sendJson(res, 500, { code: "checkpoint_commit_failed", error: "checkpoint_commit_failed" });
            }
            fileTransaction?.commit();
            runtimeActivity.delete(id);
            return sendJson(res, 200, {
              ok: true,
              session_id: id,
              draft: plan.draft,
              messages: publicStoredMessages(store.getMessages(id)),
              ...(sessionMirrorEnginePrimary()
                ? { engineCommitted: true, mutationSource: loaded.source }
                : {}),
              ...restored,
            });
          } finally {
            if (sessionReservations.get(id) === reservationToken) sessionReservations.delete(id);
          }
        }
        if (!sessionMatch[2] && req.method === "DELETE") {
          await releaseFinalizedTurn(id);
          if (controllers.has(id) || sessionReservations.has(id)) {
            return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
          }
          // A4c: remove engine before JSON when mirror is open so write failures
          // never leave JSON deleted with a live engine row. If mirror never
          // opens (infrastructure), remove JSON only (fail-open, no split-brain).
          if (sessionMirrorEnginePrimary()) {
            try {
              await removeGatewaySessionFromMirror(id);
            } catch (error) {
              return sendJson(res, 503, {
                code: "engine_mirror_write_failed",
                error: error?.message ?? "engine_mirror_write_failed",
              });
            }
            store.removeSession(id);
          } else {
            store.removeSession(id);
            try {
              await removeGatewaySessionFromMirror(id);
            } catch {
              /* fail-open dual-write when not primary */
            }
          }
          runtimeActivity.delete(id);
          sessionProtectedAllowOnce.delete(id);
          return sendJson(res, 200, { ok: true });
        }
        if (!sessionMatch[2] && req.method === "PATCH") {
          const body = await readBody(req);
          assertGatewayAcceptingMutations();
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
          if (Object.hasOwn(body, "codingMode")) {
            const raw = body.codingMode;
            if (raw === null || raw === "") {
              patch.codingMode = undefined;
            } else if (
              raw === "auto" || raw === "plan" || raw === "build" || raw === "polish"
              || raw === "deepreep" || raw === "balanced"
            ) {
              patch.codingMode = raw === "balanced" ? "auto" : raw;
            } else {
              return sendJson(res, 400, { code: "coding_mode_invalid", error: "coding_mode_invalid" });
            }
          }
          // Soft-archive: keep messages for hybrid memory FTS; hide from sidebar.
          if (Object.hasOwn(body, "archived")) {
            if (typeof body.archived !== "boolean") {
              return sendJson(res, 400, { code: "archived_invalid", error: "archived_invalid" });
            }
            if (controllers.has(id) || sessionReservations.has(id)) {
              return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
            }
            const next = store.setSessionArchived(id, body.archived);
            if (!next) return sendJson(res, 404, { code: "session_not_found", error: "session_not_found" });
            await store.flush();
            const archCommit = await commitSessionToEngine(id);
            if (!archCommit.ok && sessionMirrorEnginePrimary()) {
              return sendJson(res, 503, {
                code: "engine_mirror_write_failed",
                error: archCommit.error ?? "engine_mirror_write_failed",
              });
            }
            emitTo(id, {
              type: body.archived ? "session.archived" : "session.unarchived",
              payload: { session_id: id, archived: body.archived === true },
            });
            // Soft-archive → optional memory curator in the background (never blocks HTTP).
            // Fail-open with a hard timeout so a stuck LLM cannot hang the UI lock.
            let curatorScheduled = false;
            if (body.archived === true) {
              const engineMem = isPlainRecord(config.engine?.memory) ? config.engine.memory : {};
              const curCfg = isPlainRecord(engineMem.curator) ? engineMem.curator : {};
              if (curCfg.enabled !== false && curCfg.autoOnArchive !== false) {
                curatorScheduled = true;
                scheduleArchiveCurator(id);
              }
            }
            return sendJson(res, 200, {
              ok: true,
              session: next,
              ...(curatorScheduled ? { curatorScheduled: true } : {}),
              ...(sessionMirrorEnginePrimary() ? { engineCommitted: true } : {}),
            });
          }
          const session = store.upsertSession(patch);
          const patchCommit = await commitSessionToEngine(id);
          if (!patchCommit.ok && sessionMirrorEnginePrimary()) {
            return sendJson(res, 503, {
              code: "engine_mirror_write_failed",
              error: patchCommit.error ?? "engine_mirror_write_failed",
            });
          }
          return sendJson(res, 200, {
            ok: true,
            session,
            ...(sessionMirrorEnginePrimary() ? { engineCommitted: true } : {}),
          });
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
        const hasImages = Array.isArray(body.images) && body.images.length > 0;
        if (!sessionId || (!text && !hasImages)) {
          return sendJson(res, 400, { error: "session and text (or images) required" });
        }
        let skillIds;
        try {
          skillIds = await validatePromptSkillIds(body.skillIds);
        } catch (error) {
          const code = error instanceof Error ? error.message : "prompt_skills_invalid";
          return sendJson(res, 400, { code, error: code });
        }
        const messageId = body.messageId == null || body.messageId === "" ? undefined : String(body.messageId);
        if (messageId !== undefined && !isSessionMessageId(messageId)) {
          return sendJson(res, 400, { code: "message_id_invalid", error: "message_id_invalid" });
        }
        if (store.hasUnconsumedApprovals(sessionId)) {
          return sendJson(res, 409, { code: "approval_required", error: "approval_required" });
        }
        // Access principal (optional tag) + hard budgets (global then per-user).
        let accessPrincipal = null;
        try {
          accessPrincipal = resolveRequestPrincipal(req, {
            required: accessControlState().requireToken,
          });
        } catch (error) {
          if (error instanceof AccessTokenError) {
            return sendJson(res, error.status || 401, { code: error.code, error: error.code });
          }
          throw error;
        }
        try {
          const budget = await usageBudgetSnapshot();
          if (budget.blocked) {
            return sendJson(res, 429, {
              code: "budget_exceeded",
              error: "budget_exceeded",
              reasons: budget.hardReasons,
              budget,
            });
          }
          if (accessPrincipal?.principal) {
            const principalBudget = await principalBudgetSnapshot(accessPrincipal.principal);
            if (principalBudget?.blocked) {
              return sendJson(res, 429, {
                code: "principal_budget_exceeded",
                error: "principal_budget_exceeded",
                reasons: principalBudget.hardReasons,
                budget: principalBudget,
                principalId: accessPrincipal.id,
              });
            }
          }
        } catch (error) {
          if (error instanceof AccessTokenError) {
            return sendJson(res, error.status || 401, { code: error.code, error: error.code });
          }
          /* fail-open for ledger errors only */
        }
        await releaseFinalizedTurn(sessionId);
        if (controllers.has(sessionId) || sessionReservations.has(sessionId)) {
          return sendJson(res, 409, { code: "session_busy", error: "session_busy" });
        }
        const reservationToken = Symbol("prompt");
        sessionReservations.set(sessionId, reservationToken);
        sendJson(res, 200, { status: "streaming" });
        void runPrompt(sessionId, text, body.modelParams, messageId, reservationToken, {
          skillIds,
          ...(hasImages ? { images: body.images } : {}),
          ...(accessPrincipal ? { accessPrincipal } : {}),
        });
        return;
      }

      if (req.method === "POST" && path === "/api/cancel") {
        const body = await readBody(req);
        const sid = typeof body.session === "string" ? body.session : "";
        if (!sid) return sendJson(res, 400, { code: "session_required", error: "session_required" });
        const turn = activeTurns.get(sid);
        if (!turn) return sendJson(res, 200, { ok: true, status: "idle" });
        const messageId = await cancelActiveTurn(turn);
        return sendJson(res, 200, {
          ok: true,
          status: "interrupted",
          ...(messageId ? { message_id: messageId } : {}),
        });
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
          if (info.size > 500_000) return sendJson(res, 200, { path: rel, content: "[file too large for preview]", truncated: true });
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
          .filter((provider) => providerIsReady(provider, secrets, config))
          .flatMap((provider) => provider.models.map((model) => {
          const candidate = knownById.get(model.id);
          const known = candidate && sameModelEndpoint(provider.baseURL, candidate.baseURL) ? candidate : undefined;
          const capabilities = resolveModelCapabilities({
            providerId: provider.id,
            baseURL: provider.baseURL,
            modelId: model.id,
            live: model.capabilities,
          });
          const hasCapabilities = capabilities.provenance.source !== "unknown";
          return {
            id: model.id,
            name: model.name ?? model.id,
            provider: provider.id,
            providerName: provider.name,
            baseURL: provider.baseURL,
            ...(capabilities.limits ? { limits: capabilities.limits } : {}),
            cost: known?.cost ?? { inputPerM: 0, outputPerM: 0 },
            caps: {
              ...(known?.caps ?? {}),
              ...(capabilities.features ?? {}),
              ...(capabilities.modalities?.input?.includes("image") ? { vision: true } : {}),
            },
            ...(hasCapabilities ? { capabilities } : {}),
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
    } finally {
      activeHttpRequests.delete(activeRequest);
      finishRequest();
    }
  });

  let closePromise = null;
  const closeGateway = () => {
    if (closePromise) return closePromise;
    // Stop accepting new work immediately, cancel active engine turns and
    // direct Pipeline departments, then flush their durable state.
    gatewayClosing = true;
    shutdownController.abort();
    server.close();
    for (const controller of pipelineAdvanceControllers.values()) {
      if (!controller.signal.aborted) controller.abort(new Error("gateway_shutdown"));
    }
    closePromise = (async () => {
      const connectorClose = Promise.resolve(kiroApi.close()).catch(() => undefined);
      const organizationClose = Promise.resolve(kiroOrganizationBroker.close()).catch(() => undefined);
      // Cooperative providers settle normally; incompatible transports are
      // fenced after the bounded grace period and their latest public draft is
      // finalized before SessionStore closes.
      await Promise.all([...activeTurns.values()].map(turn => (
        cancelActiveTurn(turn, "gateway-shutdown").catch(() => undefined)
      )));
      // A request body can be received in several chunks. It must either
      // finish while the stores are still open or observe the shutdown signal;
      // otherwise a late PATCH/approval could mutate state after store.close.
      await waitForHttpRequests();
      // A background mirror resync persists its cursor after every completed
      // session. Let the in-flight row finish before closing SQLite so the
      // next launch resumes cleanly instead of recording a false failure.
      await Promise.resolve(sessionMirrorSyncPromise).catch(() => undefined);
      await sessionMirrorSyncWriteTail;
      await sessionMirrorWriteTail;
      await cronScheduler.stop();
      await configMutationTail;
      await persistence.drain();
      await teamRunStore.flush();
      await pipelineRunStore.flush();
      await workspaceLeaseStore.flush();
      await store.close();
      // Release SQLite session-mirror handles so Windows can delete temp dataDirs in tests.
      try {
        if (sessionMirrorStores && typeof sessionMirrorStores.close === "function") {
          await sessionMirrorStores.close();
        }
      } catch {
        /* best-effort */
      }
      sessionMirrorStores = null;
      sessionMirrorHandle = null;
      await connectorClose;
      await organizationClose;
      await organizationAuditTail;
    })();
    return closePromise;
  };

  const listenHost = normalizeProxyConfig(config.proxy).listenLan ? "0.0.0.0" : "127.0.0.1";
  // Create local DBs (session-mirror + workspace index/graph) before accepting traffic.
  await bootstrapLocalDatabases("start");
  return new Promise((resolve, reject) => {
    const onError = error => {
      if (error.code === "EADDRINUSE" && server.listening === false) {
        server.removeListener("error", onError);
        server.once("error", fallbackError => { void cronScheduler.stop(); reject(fallbackError); });
        server.listen(0, listenHost, () => resolve({
          port: server.address().port,
          token: gatewayToken,
          host: listenHost,
          close: closeGateway,
        }));
        return;
      }
      void cronScheduler.stop();
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferredPort, listenHost, () => resolve({
      port: server.address().port,
      token: gatewayToken,
      host: listenHost,
      close: closeGateway,
    }));
  });
}
