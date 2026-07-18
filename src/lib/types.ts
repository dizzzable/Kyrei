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

export interface FileReviewHunk {
  id: string;
  status: "pending" | "accepted" | "rejected";
  start: number;
  end: number;
  preview: string;
}

export interface FileReviewFile {
  path: string;
  tool: string;
  snapshotId?: string;
  status: "pending" | "accepted" | "rejected";
  diffPreview?: string;
  /** Full ordered ops for selective hunk apply (kind + text). */
  diffOps?: Array<{ kind: " " | "+" | "-"; text: string }>;
  /** Hunks for Kiro-style per-hunk accept/reject. */
  hunks?: FileReviewHunk[];
}

export interface FileReviewState {
  status: "pending" | "accepted" | "rejected" | "partial";
  files: FileReviewFile[];
  snapshotIds: string[];
  resolvedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  pending?: boolean;
  turnStatus?: StoredChatMessage["turnStatus"];
  fileReview?: FileReviewState;
}

export interface SessionInfo {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * Soft-archive: hidden from sidebar, messages kept for hybrid memory FTS / restore.
   * Permanent delete uses DELETE /api/sessions/:id.
   */
  archived?: boolean;
  archivedAt?: string;
  /** User fork lineage (branch). Independent of subagent parent ids. */
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageId?: string;
  forkedAt?: string;
  lineageKind?: "branch";
  /** Runtime turn status from the gateway (absent = idle). */
  status?: "idle" | "working";
  source?: "chat" | "cron" | "import";
  /** Session-scoped target. New sessions inherit the current Settings default. */
  providerId?: string;
  modelId?: string;
  /**
   * Session-scoped agent phase (auto|plan|build|polish|deepreep).
   * Overrides engine.codingMode for this chat when set.
   */
  codingMode?: "auto" | "plan" | "build" | "polish" | "deepreep";
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

export interface StoredImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  relPath: string;
  bytes: number;
}

export interface StoredChatMessage {
  id: string;
  role: ChatMessage["role"];
  content: string;
  parts?: MessagePart[];
  at?: string;
  pending?: boolean;
  turnStatus?:
    | "streaming"
    | "complete"
    | "max_steps"
    | "awaiting_approval"
    | "awaiting_file_review"
    | "interrupted"
    | "error"
    | "goal_unsatisfied"
    | "budget_exceeded"
    | "heal_handoff";
  /** Supervised-mode pending file-edit review (Kiro Supervised analogue). */
  fileReview?: FileReviewState;
  /** User-attached images for this turn (files under gateway dataDir). */
  imageAttachments?: StoredImageAttachment[];
  /** How images were presented to the model for this turn. */
  imagePresentation?: "native" | "text";
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
  /** Last completed chat-turn harness metrics (Wave E/F, no secrets). */
  harness?: {
    intentRoute?: string;
    wasteRatio?: number;
    toolPrunes?: number;
    longTaskPlanGates?: number;
    postEditVerifies?: number;
    cacheBreakpoints?: boolean;
    updatedAt?: string;
  };
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

export interface PipelineTruthGateCheck {
  id: string;
  command: string;
  ecosystem?: string;
  /** Frozen at config normalize time (sha256 of ecosystem/command/cwdPolicy). */
  testDigest?: string;
}

export interface PipelineStageDefinition {
  id: string;
  name: string;
  kind: PipelineStageKind;
  dependsOn: string[];
  allowedHelpFrom: string[];
  retry: { maxAttempts: number; backoffMs: number };
  teamProfileId?: string;
  action?: string;
  /** truth-gate only: pinned check commands for the trusted test runner. */
  checks?: PipelineTruthGateCheck[];
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

export type ProviderAccountPoolStrategy =
  | "balanced"
  | "round-robin"
  | "fill-first"
  | "spare-first"
  | "least-used";

/** Global capacity router (multi-account spare + family failover). */
export type CapacityStrategy =
  | "spare-first"
  | "fill-first"
  | "round-robin"
  | "least-used"
  | "balanced"
  | "priority";

/** Opt-in experimental capabilities behind the versioned risk disclaimer. */
export type ExperimentalFeatureId = "browserSubscriptionAuth";

export interface ExperimentalConfig {
  unlocked: boolean;
  acceptedAt: string | null;
  acceptedDisclaimerVersion: string | null;
  /** Current disclaimer version required for unlock (server-authored). */
  disclaimerVersion: string;
  /** When accessControl.requireToken is on, gate is sealed. */
  companyLocked: boolean;
  features: Partial<Record<ExperimentalFeatureId, boolean>>;
}

/** Transport hygiene for expensive API seats (Capacity → Subscription shield). */
export type SubscriptionShieldMode = "off" | "standard" | "stealth";

export interface SubscriptionShieldConfig {
  enabled: boolean;
  mode: SubscriptionShieldMode;
  minIntervalMs?: number;
  connectTimeoutMs?: number;
  maxConnectionsPerOrigin?: number;
}

export interface CapacityConfig {
  enabled: boolean;
  strategy: CapacityStrategy;
  preferSpare: boolean;
  crossProviderFamily: boolean;
  /** Default ON: pacing + soft TLS/header protection for paid keys. */
  subscriptionShield?: SubscriptionShieldConfig;
}
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
  /**
   * api-key (default) or browser-subscription (experimental gate required).
   * Tokens for browser-subscription live only in the secrets vault.
   */
  credentialSource?: "api-key" | "browser-subscription";
  browserSubscriptionSessionId?: string;
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
    /** Preferred model when codingMode is build (greenfield / implement). */
    build?: ModelRef;
    /** Preferred model when codingMode is polish (audit / bug-hunt). */
    polish?: ModelRef;
    /** Preferred model when codingMode is plan. */
    plan?: ModelRef;
    /** Preferred model when codingMode is deepreep (deep research). */
    deepreep?: ModelRef;
    fallbacks?: ModelRef[];
  };
  /** Public, secret-free multi-model team profiles. */
  orchestration?: TeamOrchestrationConfig;
  /** Durable organization workflows composed from Team profiles. */
  pipelines?: PipelinesConfig;
  /** Non-secret engine tuning (permissions/roles/budgets); shown in Advanced. */
  engine?: Record<string, unknown>;
  /**
   * Employee access principals (public metadata only; token hashes stay in secrets).
   * Used for chargeback tagging and optional require-token mode.
   */
  accessControl?: {
    requireToken: boolean;
    principals: Array<{
      id: string;
      label: string;
      prefix: string;
      enabled: boolean;
      createdAt: string;
      lastUsedAt?: string;
      softCostUsd: number | null;
      hardCostUsd: number | null;
      softTokens: number | null;
      hardTokens: number | null;
      budgetWindow: "day" | "month";
    }>;
  };
  /** OpenAI-compatible /v1 proxy + optional LAN bind. */
  proxy?: {
    enabled: boolean;
    listenLan: boolean;
    requireAccessToken: boolean;
  };
  /** Multi-account spare + cross-provider family failover. */
  capacity?: CapacityConfig;
  /**
   * Experimental / at-your-own-risk gate (browser-subscription auth, etc.).
   * Default sealed; company requireToken forces closed.
   */
  experimental?: ExperimentalConfig;
  /** Public browser-subscription session + device-flow profile metadata (no tokens). */
  browserSubscription?: {
    version?: number;
    sessions: Array<{
      id: string;
      vendorId: string;
      label: string;
      status: string;
      providerId?: string | null;
      hasStoredToken?: boolean;
      updatedAt?: string;
    }>;
    profiles?: Array<{
      id: string;
      label: string;
      vendorId?: string;
      clientId: string;
      deviceAuthorizationEndpoint: string;
      tokenEndpoint: string;
      scope?: string;
      hasClientSecret?: boolean;
      updatedAt?: string;
    }>;
    activeProfileId?: string;
  };
  /** Public messaging webhook status (token never exposed). */
  messaging?: {
    enabled: boolean;
    autoRun: boolean;
    maxBodyChars: number;
    hasToken: boolean;
  };
}

/** Full messaging status including recent inbound previews. */
export interface MessagingRuntimeStatus {
  enabled: boolean;
  autoRun: boolean;
  maxBodyChars: number;
  hasToken: boolean;
  recent: Array<{
    id: string;
    at: string;
    channel: string;
    sessionId: string;
    preview: string;
    autoRun: boolean;
    status: string;
  }>;
  note?: string;
}

export interface MessagingTokenResult {
  ok: boolean;
  token: string;
  status: MessagingRuntimeStatus;
}

/** Built-in project memory index (FTS + lexical vectors). Files remain SoT. */
export interface MemoryIndexRuntimeStatus {
  state: "ready" | "disabled" | "no_workspace" | "error";
  enabled: boolean;
  backend: "sqlite" | "postgres" | "off" | "file";
  configuredBackend: "sqlite" | "postgres" | "off";
  indexDir: string | null;
  vectorSearch: "sqlite-vec" | "pgvector" | "bruteforce" | "none";
  docCount: number;
  vectorCapable: boolean;
  tierA: {
    memoryMd: boolean;
    notesMd: boolean;
    plan: boolean;
    handoffs: number;
    ltmDecisions: boolean;
    projectIndex: boolean;
  };
  message?: string;
}

export interface MemoryIndexReindexResult {
  ok: boolean;
  upserted: number;
  vectorsUpserted: number;
  sessionUpserted?: number;
  sources: string[];
  status: MemoryIndexRuntimeStatus;
  projectFiles?: number;
  projectTruncated?: boolean;
  projectPruned?: number;
  error?: string;
}

export type MemoryGraphGroup = "project" | "code" | "document" | "decision" | "plan" | "handoff" | "session" | "memory";

export interface MemoryGraphNode {
  id: string;
  group: MemoryGraphGroup;
  title: string;
  path?: string;
  subtitle?: string;
  preview?: string;
  updatedAt?: string;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type: "imports" | "contains" | "references";
}

export interface WorkspaceMemoryGraph {
  version: 1;
  generatedAt: string;
  workspace: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  stats: {
    code: number;
    documents: number;
    decisions: number;
    sessions: number;
    edges: number;
    truncated: boolean;
  };
}

export interface ProjectDocumentImportResult {
  imported: Array<{
    fileName: string;
    path: string;
    relativePath: string;
    contentHash: string;
    bytes: number;
    deduped: boolean;
  }>;
  rejected: Array<{ fileName: string; code: string }>;
  reindex: MemoryIndexReindexResult;
}

/** Wave H: LTM decision row for Settings pin/history UI. */
export interface LtmDecisionRow {
  id: string;
  decision: string;
  rationale: string;
  validFrom: string;
  validTo: string | null;
  tags: string[];
  sessionId: string;
  pinned: boolean;
  kind: string;
  confidence: number;
  supersedes: string | null;
  lastAccessedAt: string;
  active: boolean;
}

export interface LtmDecisionsListResult {
  ok: boolean;
  count?: number;
  decisions?: LtmDecisionRow[];
  error?: string;
}

export interface LtmDecisionFetchResult {
  ok: boolean;
  decision?: LtmDecisionRow;
  history?: LtmDecisionRow[];
  error?: string;
}

export interface LtmDecisionPinResult {
  ok: boolean;
  id?: string;
  pinned?: boolean;
  previousId?: string;
  superseded?: boolean;
  unchanged?: boolean;
  error?: string;
}

/** Result of regenerating LTM runtime snapshot from the durable ledger. */
export interface LtmConsolidateResult {
  ok: boolean;
  via?: "typescript" | "python";
  error?: string;
  stdout?: string;
}

/** Persisted, resumable background synchronization from JSON chat SoT. */
export interface SessionMirrorSyncProgress {
  state: "idle" | "running" | "completed" | "failed";
  totalSessions: number;
  completedSessions: number;
  totalMessages: number;
  completedMessages: number;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
  resumable: boolean;
}

/** Dual-write chat mirror status (JSON remains write path for approvals). */
export interface SessionMirrorRuntimeStatus {
  enabled: boolean;
  readSearch: boolean;
  enginePrimary?: boolean;
  state: "ready" | "disabled" | "error";
  sessionCount: number;
  path?: string;
  note?: string;
  message?: string;
  sync?: SessionMirrorSyncProgress;
}

export interface SessionMirrorSearchHit {
  sessionId: string;
  seq: number;
  role: string;
  text: string;
  createdAt: string;
}

export interface SessionMirrorSearchResult {
  query: string;
  hits: SessionMirrorSearchHit[];
}

export interface SessionMirrorSyncResult {
  ok: boolean;
  sessions: number;
  messages: number;
  accepted?: boolean;
  alreadyRunning?: boolean;
  resumed?: boolean;
  totalSessions?: number;
  completedSessions?: number;
  totalMessages?: number;
  completedMessages?: number;
  state?: SessionMirrorSyncProgress["state"];
  resumable?: boolean;
  note?: string;
}

/** Local inspection of the deterministic prompt baseline before a chat turn. */
export interface EffectivePromptPreview {
  kind: "baseline";
  version: string;
  codingMode: string;
  workspaceSet: boolean;
  availableTools: string[];
  stable: string;
  volatile?: string;
  chars: number;
  /** Dynamic inputs intentionally excluded until a concrete turn begins. */
  omissions: string[];
}

/** Progressive cutover readiness (JSON remains write SoT for approvals/rewind). */
export interface SessionMirrorParityResult {
  enabled: boolean;
  /** True when engine SessionStore schema holds provider/approvals/pending fields. */
  schemaReady?: boolean;
  /** True when public GET prefers engine SessionStore (A4b). */
  enginePrimary?: boolean;
  /** True when mutations dual-commit to engine (A4c, same flag as enginePrimary). */
  writeThrough?: boolean;
  /**
   * True when enginePrimary is on, write-through is active, and mirror covers all JSON ids.
   * Approval/rewind algorithms still execute on JSON first, then dual-commit.
   */
  cutoverReady: boolean;
  json: { sessions: number; messages: number };
  mirror: { sessions: number; messages: number };
  missingInMirror: string[];
  extraInMirror: string[];
  blockers: string[];
  note?: string;
  message?: string;
}

/** Safe, user-facing health state for Kyrei Memory or an explicit external CLI. */
export interface GBrainRuntimeStatus {
  state: "ready" | "not_initialized" | "unavailable" | "error";
  provider: "builtin" | "external-cli";
  /** Current agent access setting, independent from whether the local store is healthy. */
  mode: "off" | "read" | "read-write";
  /** Compact doctor result; no raw local paths or diagnostics are exposed. */
  doctorStatus: "ok" | "warnings" | "error" | "unknown";
  reason?: "command_unavailable" | "adapter_unavailable" | "not_initialized" | "check_failed" | "external_setup_required";
}

export interface GBrainInitializationResult {
  status: GBrainRuntimeStatus;
  config: AppConfig;
}

/** Safe MCP connectivity diagnostics; command/env values are never echoed from env. */
export interface McpRuntimeStatus {
  enabled: boolean;
  state: "ready" | "disabled" | "no_servers" | "error";
  servers: Array<{
    id: string;
    command: string;
    transport?: "stdio" | "streamable-http" | "unsupported";
    ok: boolean;
    toolCount: number;
    error?: string;
  }>;
  message?: string;
}

/** Loopback-only embedded Postgres used as the Team memory bus. */
export interface LocalPostgresRuntimeStatus {
  state: "stopped" | "starting" | "ready" | "error" | "unavailable";
  host?: string;
  port?: number;
  vector?: boolean;
  connectionString?: string;
  error?: string;
  reason?: string;
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
