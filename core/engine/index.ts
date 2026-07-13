/**
 * Kyrei engine v2 — public entry.
 *
 * Consumed by `core/gateway.js` when `KYREI_ENGINE=v2`. The result preserves
 * terminal status and credential-free provider-attempt telemetry.
 *
 * Phase 0: types + ports + build pipeline only. `runKyreiChat` is a guarded
 * stub until Phase 1 (orchestrator on AI SDK v5) lands.
 */

import type { RunKyreiChatOpts, RunKyreiChatResult } from "./types.js";

export * from "./types.js";
export type * from "./data/ports.js";
export { runKyreiChat } from "./orchestrator/run.js";
export { createStores, createFileStores } from "./data/index.js";
export { createLtmBridge } from "./memory/ltm-bridge.js";
export { assembleSystemContext } from "./memory/layers.js";
export { writeHandoff, readHandoff, reseedFromHandoff, HandoffSchema } from "./memory/handoff.js";
export type { HandoffArtifact } from "./memory/handoff.js";
export { writeMemory, assertWritable } from "./memory/writer.js";
export { withFileLock } from "./memory/lock.js";
export { redact, containsSecret, sanitizeEnv } from "./security/secrets.js";
export { decide as decidePermission } from "./security/permissions.js";
export type { Decision } from "./security/permissions.js";
export { createAuditLog } from "./security/audit.js";
export { runPreHooks, secretScanHook } from "./security/pre-hook.js";
export type { PreHook } from "./security/pre-hook.js";
export {
  SandboxUnavailableError,
  createSandbox,
  maybeSandbox,
  commandExists,
  shSingleQuote,
} from "./security/sandbox.js";
export type { Sandbox, SandboxMode, WrapInput } from "./security/sandbox.js";
export { safePath, isWorkspaceDir } from "./security/jail.js";
export { listModels } from "./provider/registry.js";
export type { ModelEntry } from "./provider/registry.js";
export { createPlanStore } from "./orchestration/plan.js";
export { reviewDiff, runReadSwarm } from "./orchestration/reviewer.js";
export { createLogger } from "./observability/logger.js";
export type { Logger, LogLevel } from "./observability/logger.js";
export { buildSystemPrompt, PROMPT_VERSION, PROMPT_CHANGELOG } from "./prompt/system.js";
export { TOOL_DESCRIPTIONS } from "./prompt/tool-descriptions.js";
export { resolveEngineConfig, EngineConfigSchema } from "./config/schema.js";
export { createWebBrowser, assertPublicWebUrl, fetchPublicWebPage } from "./web/browser.js";
export type { WebBrowser, WebPage, WebSearchResult } from "./web/browser.js";
export {
  analyzeProjectImpact,
  buildProjectIndex,
  formatProjectImpact,
  formatProjectIndex,
  loadProjectIndex,
  persistProjectIndex,
} from "./intel/project-index.js";
export type { ProjectEdge, ProjectImpact, ProjectIndex, ProjectNode } from "./intel/project-index.js";
export { createOpenVikingClient } from "./memory/openviking.js";
export type { OpenVikingClient, OpenVikingOptions } from "./memory/openviking.js";
export { createGBrainClient, formatGBrainResult, runGBrainProcess } from "./memory/gbrain.js";
export type { GBrainClient, GBrainClientOptions, GBrainConfig, GBrainMode } from "./memory/gbrain.js";
export { buildGBrainTools } from "./tools/gbrain.js";
export { runTeamDepartment } from "./team/department.js";
export type {
  RunTeamDepartmentOptions,
  TeamDepartmentInputArtifact,
  TeamDepartmentResult,
} from "./team/department.js";
export * from "./pipeline/index.js";

export const ENGINE_VERSION = "2.0.0-dev";

export type { RunKyreiChatOpts, RunKyreiChatResult };
