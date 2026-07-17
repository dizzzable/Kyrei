/**
 * Kyrei engine v2 — public entry.
 *
 * Consumed by `core/gateway.js`, which lazily imports the built bundle and calls
 * `runKyreiChat`. The result preserves terminal status and credential-free
 * provider-attempt telemetry.
 */

import type { RunKyreiChatOpts, RunKyreiChatResult } from "./types.js";

export * from "./types.js";
export type * from "./data/ports.js";
export { runKyreiChat } from "./orchestrator/run.js";
export { createStores, createFileStores, createPostgresStores, createStoresAsync } from "./data/index.js";
export type { Stores } from "./data/index.js";
export { createLtmBridge } from "./memory/ltm-bridge.js";
export type { LtmEvent, LtmCheckpoint, LtmDecisionRecord } from "./memory/ltm-bridge.js";
export { assembleSystemContext } from "./memory/layers.js";
export { writeHandoff, readHandoff, reseedFromHandoff, HandoffSchema } from "./memory/handoff.js";
export type { HandoffArtifact } from "./memory/handoff.js";
export {
  orchestrateImport,
  detectImportFormat,
  heuristicDistill,
  redactTranscript,
  contentDigest,
  IMPORT_ADAPTERS,
  ImportError,
} from "./memory/import/index.js";
export type {
  ImportedTranscript,
  ImportOptions,
  ImportReport,
  ImportRawInput,
  ImportAdapter,
} from "./memory/import/index.js";
export { consolidateLtm } from "./memory/consolidate.js";
export type { ConsolidateResult } from "./memory/consolidate.js";
export {
  curateSession,
  heuristicCurateProposals,
  transcriptFromMessages,
  applyCuratorProposals,
  listCuratorProposals,
  applyStoredCuratorProposal,
  curatorProposalDir,
  DEFAULT_CURATOR_CONFIG,
} from "./memory/session-curator.js";
export type {
  CurateSessionInput,
  CurateSessionResult,
  CuratorApplyMode,
  CuratorModelSource,
  CuratorProposal,
  SessionCuratorConfig,
  StoredCuratorProposalFile,
} from "./memory/session-curator.js";
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
export { buildModel, buildProviderOptions } from "./provider/build.js";
export { createPlanStore } from "./orchestration/plan.js";
export type { PlanPhase, PlanState } from "./orchestration/plan.js";
export { reviewDiff, runReadSwarm } from "./orchestration/reviewer.js";
export {
  prepareMessagesForModel,
  createModelGoalJudge,
  maybeVerifyTurnGoal,
  createHealTracker,
  toolOutcomesFromSteps,
  healStateFromOutcomes,
  shouldHealHandoff,
  isBudgetBreached,
  budgetLimitsFromConfig,
} from "./reliability/runtime.js";
export {
  collectFileReviewFromParts,
  canEnterFileReview,
  applyFileReviewDecisions,
  aggregateFileReviewStatus,
  snapshotIdsForRejected,
  collectSessionFileChanges,
} from "./reliability/file-review.js";
export { matchesProtectedPath } from "./security/permissions.js";
export { cleanupIncomplete } from "./reliability/cleanup.js";
export { verifyGoal } from "./reliability/goal-verifier.js";
export type { GoalJudge, GoalVerdict } from "./reliability/goal-verifier.js";
export { checkBudget } from "./reliability/budget.js";
export type { BudgetLimits, BudgetUsage, BudgetBreach } from "./reliability/budget.js";
export {
  nextHealState,
  isTerminal,
  healStrike,
  healTranscriptMarker,
  healAgentGuidance,
} from "./reliability/self-heal.js";
export type { HealState, HealOutcome } from "./reliability/self-heal.js";
export { evaluateFinalAudit } from "./reliability/final-audit.js";
export type { FinalAuditInput, FinalAuditResult } from "./reliability/final-audit.js";
export {
  claimRunId,
  createRunStore,
  formatPhaseVerifyTable,
  defaultPhaseTemplate,
  protocolMarkdown,
  RUN_MARKERS,
} from "./orchestration/run-kit.js";
export type { RunState, RunStatus, RunStrike, RunStore, PhaseVerifyRow } from "./orchestration/run-kit.js";
export { createLogger } from "./observability/logger.js";
export type { Logger, LogLevel } from "./observability/logger.js";
export {
  buildSystemPrompt,
  buildSystemPromptParts,
  PROMPT_VERSION,
  PROMPT_CHANGELOG,
} from "./prompt/system.js";
export type { SystemPromptParts } from "./prompt/system.js";
export {
  packSystemForCache,
  joinSystemParts,
  mergeProviderOptions,
  ROLE_ROUTING_DEFAULTS,
} from "./prompt/cache-packing.js";
export type { PackedPrompt } from "./prompt/cache-packing.js";
export { TOOL_DESCRIPTIONS } from "./prompt/tool-descriptions.js";
export {
  compressToolOutput,
  compressToolOutputSync,
  detectToolContentKind,
} from "./context/tool-compress.js";
export type { ToolContentKind, CompressResult } from "./context/tool-compress.js";
export { createReadMemo, contentFingerprint } from "./context/read-memo.js";
export type { ReadMemo, ReadMemoEntry } from "./context/read-memo.js";
export { resolveEngineConfig, EngineConfigSchema } from "./config/schema.js";
export {
  BUILTIN_PERSONALITY_PRESETS,
  getPersonalityPreset,
  resolvePersonalityText,
  matchPersonalityPresetId,
} from "./personality-catalog.js";
export type { PersonalityPreset } from "./personality-catalog.js";
export {
  CODING_MODE_IDS,
  CODING_MODE_PROMPTS,
  codingModeForPipelineStage,
  codingModePrompt,
  detectCodingModeSwitch,
  effectiveCodingModeFromMessages,
  filterToolsForCodingMode,
  isCodingMode,
  isPlanModeBlockedTool,
  normalizeCodingMode,
  PLAN_MODE_BLOCKED_TOOLS,
  suggestedReasoningEffort,
  codingModePrefersReadOnly,
  codingModeAssignmentRole,
  textFromMessageContent,
} from "./coding-mode.js";
export type { CodingMode } from "./coding-mode.js";
export {
  coerceImageInputMode,
  decideImagePresentation,
  modelSupportsImageInput,
} from "./images/image-routing.js";
export type { ImageInputMode, ResolvedImagePresentation } from "./images/image-routing.js";
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
export { buildPlanningTools } from "./tools/planning.js";
export { buildOpenVikingTools } from "./tools/openviking.js";
export { buildMemorySearchTools } from "./tools/memory-search.js";
export { buildMemoryWriteTools } from "./tools/memory-write.js";
export { buildMcpTools } from "./tools/mcp.js";
export { createMcpManager, normalizeMcpConfig } from "./mcp/manager.js";
export type { McpManager } from "./mcp/manager.js";
export type { McpConfig, McpServerConfig, McpToolInfo, McpCallResult } from "./mcp/types.js";
export { DEFAULT_MCP_CONFIG } from "./mcp/types.js";
export { reindexProjectMemory } from "./memory/project-indexer.js";
export type { ReindexProjectMemoryOptions, ReindexProjectMemoryResult } from "./memory/project-indexer.js";
export {
  normalizeVaultConfig,
  scanVaultFiles,
  searchVaultFiles,
  indexVaultIntoMemory,
  DEFAULT_VAULT_CONFIG,
} from "./memory/vault.js";
export type { VaultConfig, VaultFile } from "./memory/vault.js";
export { openMemoryIndex, closeMemoryIndex } from "./memory/index-backend.js";
export type { MemoryIndexConfig, MemoryIndexBackend, OpenMemoryIndexResult } from "./memory/index-backend.js";
export { MemoryIndexSession, flushMemoryIndexPoolForTests, memoryIndexPoolSizeForTests } from "./memory/index-session.js";
export { lexicalEmbed, LEXICAL_EMBED_MODEL, LEXICAL_EMBED_DIM } from "./memory/lexical-embed.js";
export {
  createLexicalEmbedAdapter,
  createHttpEmbedAdapter,
  configureEmbedAdapterFromConfig,
  setEmbedAdapter,
  getEmbedAdapter,
  embedText,
} from "./memory/embed-adapter.js";
export type { EmbedAdapter, EmbedConfig, EmbedMode, HttpEmbedOptions } from "./memory/embed-adapter.js";
export { createSessionMirror } from "./data/session-mirror.js";
export type {
  SessionMirror,
  SessionMirrorOptions,
  GatewayMirrorSession,
  GatewayMirrorMessage,
} from "./data/session-mirror.js";
export {
  inspectWorkspaceMemoryIndex,
  reindexWorkspaceMemoryIndex,
} from "./memory/index-status.js";
export type { MemoryIndexStatus } from "./memory/index-status.js";
export {
  projectSessionsIntoMemory,
  snippetsFromModelMessages,
} from "./memory/session-project.js";
export type {
  ProjectableSession,
  ProjectableSessionMessage,
  ProjectSessionsOptions,
  ProjectSessionsResult,
} from "./memory/session-project.js";
export { runTeamDepartment } from "./team/department.js";
export type {
  RunTeamDepartmentOptions,
  TeamDepartmentInputArtifact,
  TeamDepartmentResult,
} from "./team/department.js";
export * from "./pipeline/index.js";

export const ENGINE_VERSION = "2.0.0-dev";

export type { RunKyreiChatOpts, RunKyreiChatResult };
