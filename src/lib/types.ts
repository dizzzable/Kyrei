export type Role = "user" | "assistant" | "system";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ApprovalPart {
  type: "approval";
  approvalId: string;
  toolCallId: string;
  name: string;
  args?: unknown;
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string;
  decisionReason?: string;
  consumedAt?: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: string;
  inlineDiff?: string;
  /** Opaque automatic workspace checkpoint used only by the rewind API. */
  snapshotId?: string;
  error?: string;
  running: boolean;
  awaitingApproval?: boolean;
  durationS?: number;
  /** Live progress text streamed while the tool runs (tool.progress). */
  progress?: string;
}

export type MessagePart = TextPart | ReasoningPart | ToolPart | ApprovalPart;

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  pending?: boolean;
}

export interface SessionInfo {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Runtime turn status from the gateway (absent = idle). */
  status?: "idle" | "working";
  source?: "chat" | "cron";
  /** Session-scoped target. New sessions inherit the current Settings default. */
  providerId?: string;
  modelId?: string;
  /** Soft affinity to one credential inside the provider account pool. */
  providerAccountId?: string;
  /** Live or most recent runtime activity for this session. */
  activity?: {
    active: boolean;
    phase: "thinking" | "reasoning" | "tool" | "recovering" | "responding" | "awaiting_approval" | "complete" | "failed" | "interrupted";
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
    currentTool?: string;
    /** Canonical durable assistant draft for an active turn. */
    messageId?: string;
    eventCount: number;
    toolCount: number;
    tokens?: number;
  };
}

export interface StoredChatMessage {
  id: string;
  role: ChatMessage["role"];
  content: string;
  parts?: MessagePart[];
  at?: string;
  pending?: boolean;
  turnStatus?: "streaming" | "complete" | "max_steps" | "awaiting_approval" | "interrupted" | "error";
  /** Safe gateway error metadata used to restore a failed turn after restart. */
  errorCode?: string;
  errorMessage?: string;
}

export interface GatewayStatus {
  ok: boolean;
  engine: string;
  startedAt: string;
  uptimeMs: number;
  activeRuns: number;
  platform: string;
  arch: string;
  providerReady: boolean;
  providerName: string;
  model: string;
  workspace: string;
  skills: { enabled: number; total: number };
  cron: { enabled: number; total: number; nextRunAt?: string };
  pipelines?: { active: number; total: number };
  agents: SubagentRun[];
}

export type SkillProvenance = "global" | "workspace" | "custom" | "kiro";

export interface SkillReference {
  id: string;
  label: string;
  relativePath: string;
  source: "skill" | "kiro-docs";
  /** Opaque id of the direct local index that linked this leaf. */
  parentId?: string;
}

export interface SkillRoot {
  id: string;
  path: string;
  provenance: SkillProvenance;
  owned: boolean;
  available?: boolean;
}

export interface SkillInfo {
  id: string;
  rootId: string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  owned: boolean;
  enabled: boolean;
  usage: number;
  lastUsedAt?: string;
  relativePath: string;
  content?: string;
  /** Metadata only; linked document contents remain behind the runtime tool boundary. */
  references?: SkillReference[];
}

export interface CronRun {
  id: string;
  jobId: string;
  trigger: "scheduled" | "manual";
  sessionId?: string;
  scheduledFor?: string;
  dueAt?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "complete" | "failed" | "interrupted";
  result?: string;
  error?: string;
}

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: "running" | "success" | "error" | "cancelled";
  lastScheduledAt?: string;
  nextRunAt?: string;
  runs?: CronRun[];
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface SubagentRun {
  id: string;
  parentId?: string;
  sessionId?: string;
  goal: string;
  model?: string;
  status: SubagentStatus;
  startedAt: number;
  updatedAt: number;
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCount?: number;
  filesRead: string[];
  filesWritten: string[];
  currentTool?: string;
  summary?: string;
  error?: string;
}

export type ModelModality = "text" | "image" | "audio" | "video" | "file";
export type ModelCapabilitySource = "live-provider" | "curated" | "mixed" | "user-override" | "unknown";
export type ModelCapabilityConfidence = "high" | "medium" | "low" | "unknown";
export type ModelCapabilityField =
  | "contextWindow"
  | "maxOutput"
  | "inputModalities"
  | "outputModalities"
  | "tools"
  | "reasoning"
  | "streaming";

export interface ModelCapabilityFieldProvenance {
  source: ModelCapabilitySource;
  confidence: ModelCapabilityConfidence;
  /** Present only for allowlisted official curated sources. */
  reference?: string;
}

export interface ModelCapabilityMetadata {
  limits?: {
    contextWindow?: number;
    maxOutput?: number;
  };
  modalities?: {
    input?: ModelModality[];
    output?: ModelModality[];
  };
  features?: {
    tools?: boolean;
    reasoning?: boolean;
    streaming?: boolean;
  };
  provenance: {
    source: ModelCapabilitySource;
    confidence: ModelCapabilityConfidence;
    retrievedAt?: number;
    fields: Partial<Record<ModelCapabilityField, ModelCapabilityFieldProvenance>>;
    /** Exact endpoint identity that produced live metadata; never inferred from a model id. */
    origin?: {
      protocol: ProviderProtocol;
      baseURL: string;
      modelId: string;
    };
  };
}

export interface ProviderModel {
  id: string;
  name?: string;
  /** Sanitized discovery/registry metadata; absence means unknown, never 32k by default. */
  capabilities?: ModelCapabilityMetadata;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface PromptProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export type TeamWorkflow = "supervisor" | "consensus";
export type TeamDefaultMode = "single" | "team" | "consensus";

export type TeamCapability =
  | "workspace.read"
  | "web"
  | "memory.read"
  | "skills.read"
  | "delegate";

export interface TeamRoleProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  promptProfileId?: string;
  model?: ModelRef;
  skillIds: string[];
  capabilities: TeamCapability[];
  canSpawn: boolean;
  maxChildren: number;
}

export interface TeamProfileLimits {
  maxParallel: number;
  maxDepth: number;
  maxAgents: number;
  maxTasks: number;
  maxStepsPerAgent: number;
  timeoutMs: number;
}

export interface TeamProfile {
  id: string;
  name: string;
  workflow: TeamWorkflow;
  roles: TeamRoleProfile[];
  limits: TeamProfileLimits;
  enabled: boolean;
  disabledReason?: string;
}

export interface TeamOrchestrationConfig {
  defaultMode: TeamDefaultMode;
  activeProfileId: string;
  profiles: TeamProfile[];
}

export type PipelineStageKind = "department" | "approval" | "action" | "truth-gate";

export interface PipelineStageDefinition {
  id: string;
  name: string;
  kind: PipelineStageKind;
  dependsOn: string[];
  allowedHelpFrom: string[];
  retry: { maxAttempts: number; backoffMs: number };
  teamProfileId?: string;
  action?: string;
}

export interface PipelineLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxCalls: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  maxRepairCycles: number;
  maxAssistanceRequests: number;
  maxConcurrency: number;
}

export interface PipelineDefinition {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
  disabledReason?: string;
  stages: PipelineStageDefinition[];
  limits: PipelineLimits;
}

export interface PipelinesConfig {
  version: 1;
  generation: number;
  definitions: PipelineDefinition[];
}

export type PipelineRunStatus = "queued" | "running" | "paused" | "budget_paused" | "awaiting_approval" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted";
export type PipelineStageRunStatus = "pending" | "running" | "awaiting_approval" | "blocked" | "budget_paused" | "completed" | "failed" | "skipped" | "cancelled" | "interrupted" | "uncertain";

export interface PipelineStageRun {
  id: string;
  name: string;
  kind: PipelineStageKind;
  teamProfileId?: string;
  dependsOn: string[];
  writeCapable: boolean;
  status: PipelineStageRunStatus;
  attempts: number;
  artifactIds: string[];
  uncertain: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  resolution?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PipelineRunSnapshot {
  schemaVersion: 1;
  sequence: number;
  runId: string;
  pipelineId: string;
  definitionRevision: string;
  definitionDigest: string;
  runtimeFingerprint: string;
  workspaceBaselineDigest: string;
  workspaceBaselineObservedAt: string;
  workspaceCheckpointDigest: string;
  workspaceCheckpointObservedAt: string;
  goal: string;
  workspace: string;
  workspaceHash: string;
  attachedSessionIds: string[];
  stages: PipelineStageRun[];
  artifacts: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  status: PipelineRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  interruption?: unknown;
}

export interface PipelineJournalEvent {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  type: string;
  at: string;
  payload?: unknown;
}

export interface PipelineJournalPage {
  runId: string;
  events: PipelineJournalEvent[];
  nextAfterSequence: number;
  hasMore: boolean;
}

export interface PipelineWriteResolutionMarker {
  outcome: "retry" | "applied" | "abandoned";
  workspaceDigest: string;
  observedAt: string;
  evidence: Array<{ type: "workspace" | "diff" | "file" | "command" | "test"; digest: string }>;
  note?: string;
}

export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "amazon-bedrock"
  | "google-vertex";

/** Write-only provider credentials. The gateway never returns these values. */
export interface ProviderCredentialsInput {
  apiKey?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  project?: string;
  location?: string;
  clientEmail?: string;
  privateKey?: string;
}

export type ProviderAccountPoolStrategy = "balanced" | "round-robin" | "fill-first";
export type ProviderAccountStatus = "ready" | "cooldown" | "auth-required" | "disabled";

/** Secret-free metadata for one credential in a provider account pool. */
export interface ProviderAccountMember {
  id: string;
  name: string;
  enabled: boolean;
  weight: number;
  priority: number;
  maxConcurrency: number;
  /** Missing means every current and future provider model; an empty list blocks all models. */
  modelIds?: string[];
  primary?: boolean;
  hasStoredCredentials?: boolean;
  ready?: boolean;
}

/** Public pool configuration persisted with the provider profile. */
export interface ProviderAccountPool {
  version?: number;
  enabled: boolean;
  strategy: ProviderAccountPoolStrategy;
  sessionAffinity: boolean;
  members: ProviderAccountMember[];
}

/** Runtime-safe account health returned by the local gateway. */
export interface ProviderAccount extends ProviderAccountMember {
  status: ProviderAccountStatus;
  cooldownUntil: number;
  inflight: number;
}

export interface ProviderAccountPoolSnapshot {
  providerId: string;
  pool: Pick<ProviderAccountPool, "enabled" | "strategy" | "sessionAffinity">;
  accounts: ProviderAccount[];
}

export type ProviderAccountInput = Pick<
  ProviderAccountMember,
  "id" | "name" | "enabled" | "weight" | "priority" | "maxConcurrency"
> & {
  /** `null` is a write-only reset command; public snapshots omit unrestricted assignments. */
  modelIds?: string[] | null;
};

/** Public provider metadata returned by the local gateway; never contains a key. */
export interface ProviderProfile {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  headers?: Record<string, string>;
  models: ProviderModel[];
  enabled: boolean;
  requiresApiKey: boolean;
  hasKey: boolean;
  hasStoredCredentials?: boolean;
  accountPool?: ProviderAccountPool;
}

/** Secret-free provider template returned by the local gateway. */
export interface ProviderTemplate {
  id: string;
  name: string;
  description?: string;
  descriptionKey?: string;
  docsURL?: string;
  protocol?: ProviderProtocol;
  baseURL?: string;
  models?: ProviderModel[];
  requiresApiKey?: boolean;
  requiresBaseURL?: boolean;
  custom?: boolean;
}

export interface ProviderTemplateCatalog {
  version: number;
  templates: ProviderTemplate[];
}

export interface ProviderDiscoveryInput {
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  requiresApiKey: boolean;
  /** Temporary opt-in for a trusted HTTPS hostname mapped to 198.18.0.0/15. */
  allowBenchmarkNetwork?: boolean;
  models?: ProviderModel[];
}

export interface ProviderDiscoveryResult {
  models: ProviderModel[];
  count: number;
}

export type KiroCliLoginMode = "browser" | "device";
export type KiroCliLoginMethod = "unified" | "free" | "google" | "github" | "identity-center";
export type KiroCliLoginStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
export type KiroCliAuthenticationMethod =
  | "none"
  | "github"
  | "google"
  | "builder-id"
  | "identity-center"
  | "api-key";
export type KiroCliAccountType = "none" | "free" | "enterprise" | "api-key";

/** Public, identity-free progress from an official `kiro-cli login` process. */
export interface KiroCliLoginSnapshot {
  id: string;
  status: KiroCliLoginStatus;
  mode: KiroCliLoginMode;
  method: KiroCliLoginMethod;
  startedAt: number;
  updatedAt: number;
  progress: string;
  finishedAt?: number;
  exitCode?: number;
  error?: string;
}

export interface KiroCliConnectorCapabilities {
  accountIsolation: "global";
  maxAccounts: 1;
  supportsAccountPool: false;
}

/** Sanitized connector state. It intentionally excludes account identity and credentials. */
export interface KiroCliConnectorStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  method: KiroCliAuthenticationMethod;
  accountType: KiroCliAccountType;
  capabilities: KiroCliConnectorCapabilities;
  activeLogin?: KiroCliLoginSnapshot | null;
}

export interface KiroCliLoginInput {
  mode: KiroCliLoginMode;
  method: KiroCliLoginMethod;
  identityProvider?: string;
  region?: string;
}

export interface KiroCliModel {
  id: string;
  name?: string;
}

export interface KiroCliModelCatalog {
  models: KiroCliModel[];
  count: number;
}

export interface AppConfig {
  /** Compatibility fields for legacy renderer surfaces; describe the active provider. */
  provider: string;
  model: string;
  workspace: string;
  hasKey: boolean;
  activeProviderId: string;
  activeProviderName: string;
  activeModelId: string;
  providers: ProviderProfile[];
  modelAssignments?: {
    worker?: ModelRef;
    fallbacks?: ModelRef[];
  };
  /** Public, secret-free multi-model team profiles. */
  orchestration?: TeamOrchestrationConfig;
  /** Durable organization workflows composed from Team profiles. */
  pipelines?: PipelinesConfig;
  /** Non-secret engine tuning (permissions/roles/budgets); shown in Advanced. */
  engine?: Record<string, unknown>;
}

/** Safe, user-facing health state for the optional local GBrain runtime. */
export interface GBrainRuntimeStatus {
  state: "ready" | "not_initialized" | "unavailable" | "error";
  /** Current agent access setting, independent from whether the local store is healthy. */
  mode: "off" | "read" | "read-write";
  /** Compact doctor result; no raw local paths or diagnostics are exposed. */
  doctorStatus: "ok" | "warnings" | "error" | "unknown";
  reason?: "command_unavailable" | "adapter_unavailable" | "not_initialized" | "check_failed";
}

export interface GBrainInitializationResult {
  status: GBrainRuntimeStatus;
  config: AppConfig;
}

/** Event frames streamed from the gateway (Server-Sent Events). */
export interface GatewayEvent {
  type: string;
  payload?: {
    code?: string;
    text?: string;
    tool_call_id?: string;
    approval_id?: string;
    approved?: boolean;
    consumed?: boolean;
    reason?: string;
    name?: string;
    args?: unknown;
    result?: string;
    error?: string;
    duration_s?: number;
    inline_diff?: string;
    snapshot_id?: string;
    status?: string;
    /** False only when the gateway could not durably flush a terminal turn. */
    durable?: boolean;
    session_id?: string;
    message_id?: string;
    provider_id?: string;
    model_id?: string;
    title?: string;
    message?: string;
    subagent_id?: string;
    parent_id?: string;
    child_session_id?: string;
    goal?: string;
    model?: string;
    task_count?: number;
    task_index?: number;
    duration_seconds?: number;
    input_tokens?: number;
    output_tokens?: number;
    tool_count?: number;
    files_read?: string[];
    files_written?: string[];
    summary?: string;
    current_tool?: string;
    confidence?: number;
    evidence?: string[];
    provenance?: string[];
    uncertainties?: string[];
    validation?: string[];
    what_was_not_checked?: string[];
    run_id?: string;
    task_id?: string;
    role_id?: string;
    depth?: number;
    parent_tool_call_id?: string;
  };
}
