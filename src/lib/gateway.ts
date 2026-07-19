import type {
  AppConfig,
  ChatMessage,
  CronJob,
  CronRun,
  GatewayEvent,
  GatewayStatus,
  GBrainInitializationResult,
  GBrainRuntimeStatus,
  McpRuntimeStatus,
  ProjectMcpConfig,
  ProjectMcpConfigStatus,
  MemoryIndexReindexResult,
  MemoryIndexRuntimeStatus,
  MemoryAtlasSnapshot,
  EvolutionCandidate,
  EvolutionCandidateStatus,
  EvolutionRuntimeConfig,
  ProjectDocumentImportResult,
  WorkspaceMemoryGraph,
  LtmConsolidateResult,
  LtmDecisionsListResult,
  LtmDecisionFetchResult,
  LtmDecisionPinResult,
  SessionMirrorRuntimeStatus,
  SessionMirrorSearchResult,
  SessionMirrorSyncResult,
  EffectivePromptPreview,
  SessionMirrorParityResult,
  MessagingRuntimeStatus,
  MessagingTokenResult,
  KiroCliConnectorStatus,
  KiroCliLoginInput,
  KiroCliLoginSnapshot,
  KiroCliModelCatalog,
  CodexChatgptConnectorStatus,
  CodexChatgptLoginMode,
  CodexChatgptLoginSnapshot,
  CodexChatgptPoolAccount,
  CodexChatgptPoolSnapshot,
  LocalPostgresRuntimeStatus,
  ProviderCredentialsInput,
  ProviderAccountInput,
  ProviderAccountPoolSnapshot,
  ProviderAccountPoolStrategy,
  ProviderDiscoveryInput,
  ProviderDiscoveryResult,
  ProviderProfile,
  ProviderTemplateCatalog,
  PipelinesConfig,
  PipelineJournalPage,
  PipelineRunSnapshot,
  PipelineWriteResolutionMarker,
  SessionInfo,
  SkillInfo,
  SkillRoot,
  ModelCapabilityMetadata,
} from "./types";
import type {
  KiroOrganizationAccountInput,
  KiroOrganizationCredentialInput,
  KiroOrganizationModelCatalog,
  KiroOrganizationPoolSnapshot,
} from "./kiro-organization-types";

/** A model entry from the engine registry (`GET /api/models`). */
export interface ModelCatalogEntry {
  id: string;
  name?: string;
  provider: string;
  providerName?: string;
  baseURL: string;
  /** Truthful detected/effective limits. Missing fields are unknown. */
  limits?: { contextWindow?: number; maxOutput?: number };
  cost?: { inputPerM: number; outputPerM: number };
  caps?: { tools?: boolean; reasoning?: boolean; streaming?: boolean; vision?: boolean };
  capabilities?: ModelCapabilityMetadata;
}

/** Per-turn reasoning/effort tuning forwarded to the engine. */
export interface ModelParams {
  effort?: string;
  fast?: boolean;
  reasoning?: boolean;
  contextWindowOverride?: number;
  maxOutputOverride?: number;
}

/** Soft/hard spend caps from engine.usageBudget. */
export interface UsageBudgetConfig {
  enabled: boolean;
  window: "day" | "month";
  softCostUsd: number | null;
  hardCostUsd: number | null;
  softTokens: number | null;
  hardTokens: number | null;
}

export interface UsageBudgetSnapshot {
  config: UsageBudgetConfig;
  level: "ok" | "soft" | "hard";
  blocked: boolean;
  warnings: string[];
  hardReasons: string[];
  usage: {
    totalTokens: number;
    costUsd: number;
    requestCount: number;
    sinceMs: number;
    window: "day" | "month";
  };
  remaining: {
    softCostUsd: number | null;
    hardCostUsd: number | null;
    softTokens: number | null;
    hardTokens: number | null;
  };
}

/** Wave D/E coding-harness efficiency snapshot (no secrets). */
export interface HarnessMetricsSummary {
  sessionId?: string;
  turns: number;
  toolPrunes: number;
  toolBytesRaw: number;
  toolBytesShown: number;
  goalSkims: number;
  workingStatePins: number;
  softOverflows: number;
  hardOverflows: number;
  stageBSummaries: number;
  longTaskPlanGates: number;
  goalVerifies: number;
  intentRoute?: string;
  intentReason?: string;
  postEditVerifies: number;
  postEditFailures: number;
  symbolMapCacheHits: number;
  cacheBreakpoints: boolean;
  wasteRatio?: number;
  updatedAt?: string;
}

/** Durable usage ledger summary (`GET /api/usage`). */
export interface UsageSummary {
  days: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  byProvider: Array<{ key: string; requestCount: number; totalTokens: number; costUsd: number }>;
  byModel: Array<{ key: string; requestCount: number; totalTokens: number; costUsd: number }>;
  byDay: Array<{ day: string; requestCount: number; totalTokens: number; costUsd: number }>;
  budget?: UsageBudgetSnapshot;
  /** Last completed chat turn harness metrics (Wave E). */
  harness?: HarnessMetricsSummary;
}

/** One accounting row from `GET /api/usage/events` (no prompts/secrets). */
export interface UsageLedgerEvent {
  id: string;
  ts: string;
  kind: string;
  sessionId?: string;
  providerId?: string;
  accountId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  status?: string;
  latencyMs?: number;
  accessTokenId?: string;
  principalLabel?: string;
}

/** Public employee principal (hash never exposed). */
export interface AccessPrincipal {
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
  /** Empty keeps the legacy unrestricted route scope. */
  allowedModels: string[];
  expiresAt?: string;
}

export interface AccessControlPublic {
  requireToken: boolean;
  principals: AccessPrincipal[];
}

export interface AccessTokenUsage {
  id: string;
  requestCount: number;
  totalTokens: number;
  costUsd: number;
}

export interface CompanyGatewayInfo {
  proxy: {
    enabled: boolean;
    listenLan: boolean;
    requireAccessToken: boolean;
    restartRequired: boolean;
  };
  endpoints: Array<{ kind: "loopback" | "lan"; baseUrl: string }>;
  modelRefFormat: "providerId/modelId";
}

const launchParams = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

function resolveBase(): string {
  const port = launchParams.get("port") || "8765";
  return `http://127.0.0.1:${port}`;
}

const BASE = resolveBase();
const GATEWAY_TOKEN = launchParams.get("gatewayToken") || "";

export type GatewayErrorCode = "capability_unavailable" | "request_failed";

export class GatewayRequestError extends Error {
  readonly code: GatewayErrorCode;
  readonly status?: number;
  readonly detail?: string;
  readonly serverCode?: string;
  readonly serverArgs?: Readonly<Record<string, string | number | boolean>>;

  constructor(code: GatewayErrorCode, options: {
    status?: number;
    detail?: string;
    serverCode?: string;
    serverArgs?: Readonly<Record<string, string | number | boolean>>;
  } = {}) {
    super(options.detail || code);
    this.name = "GatewayRequestError";
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.serverCode = options.serverCode;
    this.serverArgs = options.serverArgs;
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  if (!GATEWAY_TOKEN) throw new GatewayRequestError("capability_unavailable");
  const method = String(init?.method ?? "GET").toUpperCase();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Kyrei-Gateway-Token": GATEWAY_TOKEN, ...(init?.headers || {}) },
    });
  } catch (error) {
    // Browser fetch exposes local gateway shutdown/boot races as the opaque
    // `TypeError: Failed to fetch`. Keep that detail out of the UI and give
    // callers a stable, retryable error code instead.
    throw new GatewayRequestError("request_failed", {
      detail: "gateway_unreachable",
      serverCode: method === "GET" ? "gateway_unreachable" : "gateway_request_failed",
    });
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText);
    let detail = raw;
    let serverCode: string | undefined;
    let serverArgs: Readonly<Record<string, string | number | boolean>> | undefined;
    try {
      const body = JSON.parse(raw) as { code?: unknown; error?: unknown; detail?: unknown; args?: unknown };
      serverCode = typeof body.code === "string" ? body.code : undefined;
      detail = typeof body.detail === "string"
        ? body.detail
        : !serverCode && typeof body.error === "string"
          ? body.error
          : "";
      serverArgs = body.args && typeof body.args === "object"
        ? body.args as Record<string, string | number | boolean>
        : undefined;
    } catch {
      // Non-JSON failures remain raw technical detail.
    }
    throw new GatewayRequestError("request_failed", { status: res.status, detail, serverCode, serverArgs });
  }
  return res.json() as Promise<T>;
}

export const gateway = {
  base: BASE,

  getStatus: () => json<GatewayStatus>("/api/status"),
  retryAgent: (id: string) => json<{ ok: true; status: string }>(`/api/agents/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" }),
  resumeAgent: (id: string) => json<{ ok: true; status: string }>(`/api/agents/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" }),
  cancelAgent: (id: string) => json<{ ok: true; status: string }>(`/api/agents/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),

  getConfig: () => json<AppConfig>("/api/config"),
  getGBrainStatus: () => json<GBrainRuntimeStatus>("/api/memory/gbrain"),
  getMcpStatus: () => json<McpRuntimeStatus>("/api/memory/mcp"),
  getProjectMcpConfig: () => json<ProjectMcpConfigStatus>("/api/mcp/project"),
  saveProjectMcpConfig: (config: ProjectMcpConfig) =>
    json<ProjectMcpConfigStatus>("/api/mcp/project", { method: "PUT", body: JSON.stringify({ config }) }),
  setProjectMcpTrust: (trusted: boolean) =>
    json<ProjectMcpConfigStatus>("/api/mcp/project/trust", { method: "POST", body: JSON.stringify({ trusted }) }),
  getLocalPostgresStatus: () => json<LocalPostgresRuntimeStatus>("/api/memory/local-postgres"),
  ensureLocalPostgres: () => json<LocalPostgresRuntimeStatus>("/api/memory/local-postgres/ensure", { method: "POST" }),
  initializeGBrain: () => json<GBrainInitializationResult>("/api/memory/gbrain/initialize", { method: "POST" }),
  installGBrain: () => json<GBrainInitializationResult>("/api/memory/gbrain/install", { method: "POST" }),
  getMemoryIndexStatus: () => json<MemoryIndexRuntimeStatus>("/api/memory/index"),
  reindexMemoryIndex: () => json<MemoryIndexReindexResult>("/api/memory/index/reindex", { method: "POST" }),
  getMemoryGraph: () => json<WorkspaceMemoryGraph>("/api/memory/graph"),
  getMemoryAtlas: () => json<{ atlas: MemoryAtlasSnapshot }>("/api/memory/atlas").then((result) => result.atlas),
  getEvolutionCandidates: () => json<{ config: EvolutionRuntimeConfig; candidates: EvolutionCandidate[] }>("/api/evolution/candidates"),
  transitionEvolutionCandidate: (id: string, body: { expectedRevision: number; status: EvolutionCandidateStatus; reason?: string; evidence?: { receipts?: string[]; tests?: string[]; notes?: string } }) =>
    json<{ candidate: EvolutionCandidate }>(`/api/evolution/candidates/${encodeURIComponent(id)}/transition`, { method: "POST", body: JSON.stringify(body) }),
  importProjectDocuments: (files: Array<{ fileName: string; relativePath?: string; contentBase64: string }>) =>
    json<ProjectDocumentImportResult>("/api/memory/documents/import", {
      method: "POST",
      body: JSON.stringify({ files }),
    }),
  consolidateLtm: () => json<LtmConsolidateResult>("/api/memory/ltm/consolidate", { method: "POST" }),
  listLtmDecisions: (includeInvalidated = false) =>
    json<LtmDecisionsListResult>(
      `/api/memory/ltm/decisions?includeInvalidated=${includeInvalidated ? "1" : "0"}`,
    ),
  fetchLtmDecision: (id: string) =>
    json<LtmDecisionFetchResult>(
      `/api/memory/ltm/decisions/fetch?id=${encodeURIComponent(id)}`,
    ),
  pinLtmDecision: (id: string, pinned = true) =>
    json<LtmDecisionPinResult>("/api/memory/ltm/decisions/pin", {
      method: "POST",
      body: JSON.stringify({ id, pinned }),
    }),
  getSessionMirrorStatus: () => json<SessionMirrorRuntimeStatus>("/api/memory/session-mirror"),
  searchSessionMirror: (q: string, limit = 20) =>
    json<SessionMirrorSearchResult>(
      `/api/memory/session-mirror/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  syncSessionMirror: () => json<SessionMirrorSyncResult>("/api/memory/session-mirror/sync", { method: "POST" }),
  getEffectivePromptPreview: () => json<EffectivePromptPreview>("/api/prompt/effective"),
  getSessionMirrorParity: () => json<SessionMirrorParityResult>("/api/memory/session-mirror/parity"),
  getMessagingStatus: () => json<MessagingRuntimeStatus>("/api/messaging"),
  rotateMessagingToken: () => json<MessagingTokenResult>("/api/messaging/token", { method: "POST" }),
  setConfig: (patch: Partial<{
    provider: string;
    apiKey: string;
    clearApiKey: boolean;
    model: string;
    activeModelId: string;
    activeProviderId: string;
    providers: ProviderProfile[];
    modelAssignments: AppConfig["modelAssignments"];
    orchestration: AppConfig["orchestration"];
    pipelines: AppConfig["pipelines"];
    workspace: string;
    engine: Record<string, unknown>;
    proxy: AppConfig["proxy"];
    accessControl: AppConfig["accessControl"];
    capacity: AppConfig["capacity"];
    experimental: AppConfig["experimental"];
    /** Required once when unlocking the experimental gate. */
    experimentalAcceptPhrase: string;
  }>) =>
    json<AppConfig>("/api/config", { method: "PUT", body: JSON.stringify(patch) }),

  getBrowserSubscriptionAuth: () =>
    json<{
      allowed: boolean;
      vendors: Array<{ id: string; label: string; defaultBaseURL: string; docsHint?: string; protocol?: string }>;
      sessions: Array<{
        id: string;
        vendorId: string;
        label: string;
        status: string;
        providerId?: string | null;
        hasStoredToken?: boolean;
        updatedAt?: string;
        flow?: string;
        userCode?: string;
        verificationUri?: string;
      }>;
      profiles: Array<{
        id: string;
        label: string;
        vendorId?: string;
        clientId: string;
        deviceAuthorizationEndpoint: string;
        tokenEndpoint: string;
        scope?: string;
        hasClientSecret?: boolean;
      }>;
      activeProfileId?: string;
    }>("/api/experimental/browser-subscription"),
  saveBrowserSubscriptionProfile: (input: {
    id?: string;
    label?: string;
    vendorId?: string;
    clientId: string;
    deviceAuthorizationEndpoint: string;
    tokenEndpoint: string;
    scope?: string;
    clientSecret?: string;
    clearClientSecret?: boolean;
  }) =>
    json<{ profile: { id: string; label: string; hasClientSecret?: boolean }; snapshot: unknown }>(
      "/api/experimental/browser-subscription/profiles",
      { method: "POST", body: JSON.stringify(input) },
    ),
  activateBrowserSubscriptionProfile: (profileId: string) =>
    json<{ snapshot: unknown }>(
      `/api/experimental/browser-subscription/profiles/${encodeURIComponent(profileId)}/activate`,
      { method: "POST", body: "{}" },
    ),
  deleteBrowserSubscriptionProfile: (profileId: string) =>
    json<{ snapshot: unknown }>(
      `/api/experimental/browser-subscription/profiles/${encodeURIComponent(profileId)}`,
      { method: "DELETE" },
    ),
  startBrowserSubscriptionSession: (input: {
    vendorId: string;
    label?: string;
    providerId?: string;
    flow?: "manual" | "device";
    profileId?: string;
    /** Full registration, or partial overrides when profileId is set. */
    deviceFlow?: {
      clientId?: string;
      deviceAuthorizationEndpoint?: string;
      tokenEndpoint?: string;
      scope?: string;
      clientSecret?: string;
    };
  }) =>
    json<{
      session: {
        id: string;
        status: string;
        vendorId: string;
        label: string;
        flow?: string;
        userCode?: string;
        verificationUri?: string;
        verificationUriComplete?: string;
        pollIntervalSec?: number;
        deviceExpiresAt?: string;
      };
      nextStep: string;
      snapshot: unknown;
    }>("/api/experimental/browser-subscription/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  pollBrowserSubscriptionSession: (sessionId: string) =>
    json<{
      session: {
        id: string;
        status: string;
        userCode?: string;
        verificationUri?: string;
        pollIntervalSec?: number;
        errorCode?: string;
      };
      pollStatus: string;
      snapshot: unknown;
    }>(
      `/api/experimental/browser-subscription/sessions/${encodeURIComponent(sessionId)}/poll`,
      { method: "POST", body: "{}" },
    ),
  bindBrowserSubscriptionToken: (
    sessionId: string,
    input: { accessToken: string; refreshToken?: string; expiresAt?: string },
  ) =>
    json<{ session: { id: string; status: string }; snapshot: unknown }>(
      `/api/experimental/browser-subscription/sessions/${encodeURIComponent(sessionId)}/token`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  linkBrowserSubscriptionSession: (sessionId: string, providerId: string) =>
    json<{ snapshot: unknown; config?: AppConfig }>(
      `/api/experimental/browser-subscription/sessions/${encodeURIComponent(sessionId)}/link`,
      { method: "POST", body: JSON.stringify({ providerId }) },
    ),
  revokeBrowserSubscriptionSession: (sessionId: string) =>
    json<{ session: unknown; snapshot: unknown }>(
      `/api/experimental/browser-subscription/sessions/${encodeURIComponent(sessionId)}/revoke`,
      { method: "POST", body: "{}" },
    ),
  deleteBrowserSubscriptionSession: (sessionId: string) =>
    json<{ snapshot: unknown }>(
      `/api/experimental/browser-subscription/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  getPipelines: () => json<PipelinesConfig>("/api/pipelines"),
  setPipelines: (pipelines: PipelinesConfig) =>
    json<PipelinesConfig>("/api/pipelines", { method: "PUT", body: JSON.stringify(pipelines) }),
  listPipelineRuns: () =>
    json<{ runs: PipelineRunSnapshot[] }>("/api/pipeline-runs").then((result) => result.runs),
  createPipelineRun: (input: { pipelineId: string; goal: string; sessionId?: string }) =>
    json<{ run: PipelineRunSnapshot }>("/api/pipeline-runs", { method: "POST", body: JSON.stringify(input) }).then((result) => result.run),
  getPipelineRun: (id: string) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}`).then((result) => result.run),
  getPipelineRunJournal: (id: string, options: { afterSequence?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined) query.set("afterSequence", String(options.afterSequence));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return json<PipelineJournalPage>(`/api/pipeline-runs/${encodeURIComponent(id)}/journal${suffix}`);
  },
  startPipelineRun: (id: string) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" }).then((result) => result.run),
  pausePipelineRun: (id: string, reason?: string) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/pause`, { method: "POST", body: JSON.stringify({ reason }) }).then((result) => result.run),
  recordPipelineArtifact: (id: string, artifact: unknown) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/artifact`, { method: "POST", body: JSON.stringify({ artifact }) }).then((result) => result.run),
  resumePipelineRun: (id: string, resolution?: { resolutionMarker?: PipelineWriteResolutionMarker; resolutionMarkers?: Record<string, PipelineWriteResolutionMarker> }) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify(resolution ?? {}) }).then((result) => result.run),
  cancelPipelineRun: (id: string, reason?: string) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }).then((result) => result.run),
  recordPipelineApproval: (id: string, approval: { id?: string; stageId: string; status: "requested" | "approved" | "rejected" | "cancelled" | "expired"; actor?: string; reason?: string; evidence?: unknown[]; metadata?: Record<string, unknown> }) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/approval`, { method: "POST", body: JSON.stringify(approval) }).then((result) => result.run),
  attachPipelineSession: (id: string, sessionId: string) =>
    json<{ run: PipelineRunSnapshot }>(`/api/pipeline-runs/${encodeURIComponent(id)}/attach-session`, { method: "POST", body: JSON.stringify({ sessionId }) }).then((result) => result.run),
  getProviders: () => json<{ providers: ProviderProfile[]; activeProviderId: string; activeModelId: string }>("/api/providers"),
  getProviderTemplates: () => json<ProviderTemplateCatalog>("/api/provider-templates"),
  createProvider: (
    provider: Partial<ProviderProfile>,
    options: { apiKey?: string; credentials?: ProviderCredentialsInput; useAsDefault?: boolean } = {},
  ) =>
    json<AppConfig>("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider,
        ...(options.credentials ? { credentials: options.credentials } : options.apiKey ? { apiKey: options.apiKey } : {}),
        useAsDefault: options.useAsDefault === true,
      }),
    }),
  updateProvider: (
    id: string,
    provider: Partial<ProviderProfile>,
    options: { apiKey?: string; credentials?: ProviderCredentialsInput; useAsDefault?: boolean } = {},
  ) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        provider,
        ...(options.credentials ? { credentials: options.credentials } : options.apiKey ? { apiKey: options.apiKey } : {}),
        useAsDefault: options.useAsDefault === true,
      }),
    }),
  discoverProvider: (profile: ProviderDiscoveryInput, credentials?: ProviderCredentialsInput) =>
    json<ProviderDiscoveryResult>("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify({ profile, ...(credentials ? { credentials } : {}) }),
    }),
  discoverSavedProvider: (id: string) =>
    json<ProviderDiscoveryResult>(`/api/providers/${encodeURIComponent(id)}/discover`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  resetProviderRuntime: (id: string, accountId?: string) =>
    json<{ ok: true; scope: "provider" | "account"; accountId?: string; runtime: ProviderAccountPoolSnapshot }>(
      `/api/providers/${encodeURIComponent(id)}/runtime/reset`,
      { method: "POST", body: JSON.stringify(accountId ? { accountId } : {}) },
    ),
  deleteProvider: (id: string) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setProviderSecret: (id: string, credentials: ProviderCredentialsInput | string) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}/secret`, {
      method: "PUT",
      body: JSON.stringify(typeof credentials === "string" ? { apiKey: credentials } : { credentials }),
    }),
  clearProviderSecret: (id: string) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}/secret`, { method: "DELETE" }),
  getProviderAccounts: (providerId: string) =>
    json<ProviderAccountPoolSnapshot>(`/api/providers/${encodeURIComponent(providerId)}/accounts`),
  updateProviderAccountPool: (
    providerId: string,
    pool: { enabled: boolean; strategy: ProviderAccountPoolStrategy; sessionAffinity: boolean },
  ) =>
    json<ProviderAccountPoolSnapshot>(`/api/providers/${encodeURIComponent(providerId)}/pool`, {
      method: "PATCH",
      body: JSON.stringify({ pool }),
    }),
  createProviderAccount: (
    providerId: string,
    account: ProviderAccountInput,
    credentials?: ProviderCredentialsInput,
  ) =>
    json<ProviderAccountPoolSnapshot>(`/api/providers/${encodeURIComponent(providerId)}/accounts`, {
      method: "POST",
      body: JSON.stringify({ account, ...(credentials ? { credentials } : {}) }),
    }),
  updateProviderAccount: (
    providerId: string,
    accountId: string,
    account: Partial<ProviderAccountInput>,
    credentials?: ProviderCredentialsInput,
  ) =>
    json<ProviderAccountPoolSnapshot>(
      `/api/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ account, ...(credentials ? { credentials } : {}) }),
      },
    ),
  deleteProviderAccount: (providerId: string, accountId: string) =>
    json<ProviderAccountPoolSnapshot>(
      `/api/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    ),
  discoverProviderAccount: (providerId: string, accountId: string) =>
    json<ProviderDiscoveryResult>(
      `/api/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/discover`,
      { method: "POST", body: "{}" },
    ),
  getKiroCliConnector: () =>
    json<KiroCliConnectorStatus>("/api/connectors/kiro"),
  startKiroCliLogin: (input: KiroCliLoginInput) =>
    json<{ login: KiroCliLoginSnapshot }>("/api/connectors/kiro/login", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((result) => result.login),
  getKiroCliLogin: (id: string) =>
    json<{ login: KiroCliLoginSnapshot }>(`/api/connectors/kiro/login/${encodeURIComponent(id)}`)
      .then((result) => result.login),
  cancelKiroCliLogin: (id: string) =>
    json<{ login: KiroCliLoginSnapshot }>(`/api/connectors/kiro/login/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then((result) => result.login),
  getKiroCliModels: () =>
    json<KiroCliModelCatalog>("/api/connectors/kiro/models"),
  logoutKiroCli: () =>
    json<{ loggedOut: true }>("/api/connectors/kiro/logout", { method: "POST", body: "{}" }),
  getCodexChatgptConnector: () =>
    json<CodexChatgptConnectorStatus>("/api/connectors/codex"),
  startCodexChatgptLogin: (mode: CodexChatgptLoginMode) =>
    json<{ login: CodexChatgptLoginSnapshot }>("/api/connectors/codex/login", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }).then((result) => result.login),
  getCodexChatgptLogin: (id: string) =>
    json<{ login: CodexChatgptLoginSnapshot }>(`/api/connectors/codex/login/${encodeURIComponent(id)}`)
      .then((result) => result.login),
  cancelCodexChatgptLogin: (id: string) =>
    json<{ login: CodexChatgptLoginSnapshot }>(`/api/connectors/codex/login/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then((result) => result.login),
  logoutCodexChatgpt: () =>
    json<{ loggedOut: true }>("/api/connectors/codex/logout", { method: "POST", body: "{}" }),
  activateCodexChatgpt: () =>
    json<AppConfig>("/api/connectors/codex/activate", { method: "POST", body: "{}" }),
  getCodexChatgptPool: () =>
    json<CodexChatgptPoolSnapshot>("/api/connectors/codex/pool"),
  updateCodexChatgptPool: (input: Pick<CodexChatgptPoolSnapshot, "enabled" | "strategy" | "sessionAffinity">) =>
    json<CodexChatgptPoolSnapshot>("/api/connectors/codex/pool", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  activateCodexChatgptPool: () =>
    json<AppConfig>("/api/connectors/codex/pool/activate", { method: "POST", body: "{}" }),
  createCodexChatgptPoolAccount: (account: Pick<CodexChatgptPoolAccount, "id" | "name"> & Partial<Pick<CodexChatgptPoolAccount, "enabled" | "weight" | "priority" | "modelIds">>) =>
    json<CodexChatgptPoolSnapshot>("/api/connectors/codex/pool/accounts", {
      method: "POST",
      body: JSON.stringify({ account }),
    }),
  updateCodexChatgptPoolAccount: (accountId: string, account: Partial<Pick<CodexChatgptPoolAccount, "name" | "enabled" | "weight" | "priority" | "modelIds">>) =>
    json<CodexChatgptPoolSnapshot>(`/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: JSON.stringify({ account }),
    }),
  deleteCodexChatgptPoolAccount: (accountId: string) =>
    json<CodexChatgptPoolSnapshot>(`/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      body: "{}",
    }),
  refreshCodexChatgptPoolAccount: (accountId: string) =>
    json<{ accountId: string; status: CodexChatgptConnectorStatus; pool: CodexChatgptPoolSnapshot }>(
      `/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}`,
    ),
  startCodexChatgptPoolLogin: (accountId: string, mode: CodexChatgptLoginMode) =>
    json<{ login: CodexChatgptLoginSnapshot }>(`/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}/login`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }).then((result) => result.login),
  getCodexChatgptPoolLogin: (accountId: string, loginId: string) =>
    json<{ login: CodexChatgptLoginSnapshot }>(
      `/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}/login/${encodeURIComponent(loginId)}`,
    ).then((result) => result.login),
  cancelCodexChatgptPoolLogin: (accountId: string, loginId: string) =>
    json<{ login: CodexChatgptLoginSnapshot }>(
      `/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}/login/${encodeURIComponent(loginId)}`,
      { method: "DELETE" },
    ).then((result) => result.login),
  logoutCodexChatgptPoolAccount: (accountId: string) =>
    json<{ loggedOut: true; pool: CodexChatgptPoolSnapshot }>(
      `/api/connectors/codex/pool/accounts/${encodeURIComponent(accountId)}/logout`,
      { method: "POST", body: "{}" },
    ),
  getKiroOrganizationPool: () =>
    json<KiroOrganizationPoolSnapshot>("/api/connectors/kiro/organization"),
  updateKiroOrganizationPool: (
    input: Pick<KiroOrganizationPoolSnapshot, "enabled" | "strategy" | "sessionAffinity"> & { expectedGeneration: number },
  ) =>
    json<KiroOrganizationPoolSnapshot>("/api/connectors/kiro/organization/pool", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  createKiroOrganizationAccount: (
    account: KiroOrganizationAccountInput,
    expectedGeneration: number,
    credential?: KiroOrganizationCredentialInput,
  ) =>
    json<KiroOrganizationPoolSnapshot>("/api/connectors/kiro/organization/accounts", {
      method: "POST",
      body: JSON.stringify({ account, expectedGeneration, ...(credential ? { credential } : {}) }),
    }),
  updateKiroOrganizationAccount: (
    accountId: string,
    account: Partial<KiroOrganizationAccountInput>,
    expectedRevision: number,
    credential?: KiroOrganizationCredentialInput,
  ) =>
    json<KiroOrganizationPoolSnapshot>(
      `/api/connectors/kiro/organization/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ account, expectedRevision, ...(credential ? { credential } : {}) }),
      },
    ),
  deleteKiroOrganizationAccount: (accountId: string, expectedRevision: number) =>
    json<KiroOrganizationPoolSnapshot>(
      `/api/connectors/kiro/organization/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE", body: JSON.stringify({ expectedRevision }) },
    ),
  verifyKiroOrganizationAccount: (accountId: string, expectedRevision: number) =>
    json<KiroOrganizationPoolSnapshot>(
      `/api/connectors/kiro/organization/accounts/${encodeURIComponent(accountId)}/verify`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    ),
  getKiroOrganizationAccountModels: (accountId: string) =>
    json<KiroOrganizationModelCatalog>(
      `/api/connectors/kiro/organization/accounts/${encodeURIComponent(accountId)}/models`,
      { method: "POST", body: "{}" },
    ),
  revokeKiroOrganizationAccount: (accountId: string, expectedRevision: number) =>
    json<KiroOrganizationPoolSnapshot>(
      `/api/connectors/kiro/organization/accounts/${encodeURIComponent(accountId)}/revoke`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    ),
  chooseFolder: () => json<{ folder: string } & AppConfig>("/api/choose-folder", { method: "POST" }),

  listSkills: () => json<{ skills: SkillInfo[]; roots: SkillRoot[] }>("/api/skills"),
  getSkill: (id: string) => json<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(id)}`).then((result) => result.skill),
  setSkillEnabled: (id: string, enabled: boolean) =>
    json<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }).then((result) => result.skill),
  createSkill: (input: { name: string; description?: string; content?: string; rootId?: string }) =>
    json<{ skill: SkillInfo }>("/api/skills", { method: "POST", body: JSON.stringify(input) }).then((result) => result.skill),
  deleteSkill: (id: string) => json<{ ok: boolean }>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addSkillRoot: () => json<{ roots: SkillRoot[]; folder?: string }>("/api/skills/roots", { method: "POST" }),
  removeSkillRoot: (id: string) => json<{ roots: SkillRoot[] }>(`/api/skills/roots/${encodeURIComponent(id)}`, { method: "DELETE" }),
  openSkillRoot: (id: string) => json<{ ok: boolean }>(`/api/skills/roots/${encodeURIComponent(id)}/open`, { method: "POST" }),
  /** Optional skills catalog curator (default OFF). */
  scanSkillsCurator: (input?: { applyMode?: "propose" | "apply_safe"; force?: boolean }) =>
    json<{
      ok: boolean;
      proposals?: Array<Record<string, unknown>>;
      applied?: string[];
      summary?: string;
      error?: string;
      fileName?: string;
      proposalPath?: string;
    }>("/api/skills/curator/scan", { method: "POST", body: JSON.stringify(input ?? {}) }),
  listSkillsCuratorProposals: () =>
    json<{
      proposals: Array<{
        fileName: string;
        status?: string;
        at?: string;
        via?: string;
        proposalCount?: number;
        preview?: Array<{
          id?: string;
          skillId?: string;
          skillName?: string;
          action?: string;
          kind?: string;
          reason?: string;
          detail?: string;
          owned?: boolean;
          patchSummary?: string;
          suggestedDescription?: string;
          hasContentPatch?: boolean;
        }>;
      }>;
    }>("/api/skills/curator/proposals"),
  applySkillsCuratorProposal: (fileName: string) =>
    json<{ ok: boolean; applied?: string[]; summary?: string; error?: string }>(
      "/api/skills/curator/proposals/apply",
      { method: "POST", body: JSON.stringify({ fileName }) },
    ),
  applySkillsCuratorOne: (
    skillId: string,
    action: "enable" | "disable" | "apply_patch" | "suggest_patch",
    opts?: {
      fileName?: string;
      proposalId?: string;
      suggestedContent?: string;
      suggestedDescription?: string;
    },
  ) =>
    json<{ ok: boolean; skillId?: string; enabled?: boolean; patched?: boolean; error?: string }>(
      "/api/skills/curator/proposals/apply-one",
      {
        method: "POST",
        body: JSON.stringify({
          skillId,
          action,
          ...(opts?.fileName ? { fileName: opts.fileName } : {}),
          ...(opts?.proposalId ? { proposalId: opts.proposalId } : {}),
          ...(opts?.suggestedContent ? { suggestedContent: opts.suggestedContent } : {}),
          ...(opts?.suggestedDescription ? { suggestedDescription: opts.suggestedDescription } : {}),
        }),
      },
    ),

  /** Wave C1: skill sleep (trajectory harvest → proposals only). */
  runSkillSleep: (input?: { force?: boolean; limit?: number; trajectories?: unknown[] }) =>
    json<{
      ok: boolean;
      proposals?: Array<Record<string, unknown>>;
      summary?: string;
      error?: string;
      fileName?: string;
      proposalPath?: string;
    }>("/api/skills/sleep", { method: "POST", body: JSON.stringify(input ?? {}) }),

  /** Wave C2: curated skill packs. */
  listSkillPacks: () =>
    json<{
      packs: Array<{
        id: string;
        name: string;
        description: string;
        tags?: string[];
        path: string;
        available: boolean;
        skillCount: number;
        enabled: boolean;
      }>;
    }>("/api/skills/packs"),
  enableSkillPack: (packId: string) =>
    json<{
      ok: boolean;
      packId?: string;
      already?: boolean;
      skills?: SkillInfo[];
      roots?: SkillRoot[];
      packs?: Array<Record<string, unknown>>;
      error?: string;
    }>("/api/skills/packs/enable", { method: "POST", body: JSON.stringify({ packId }) }),
  disableSkillPack: (packId: string) =>
    json<{
      ok: boolean;
      packId?: string;
      already?: boolean;
      skills?: SkillInfo[];
      roots?: SkillRoot[];
      packs?: Array<Record<string, unknown>>;
      error?: string;
    }>("/api/skills/packs/disable", { method: "POST", body: JSON.stringify({ packId }) }),

  listCronJobs: () => json<{ jobs: CronJob[] }>("/api/cron/jobs").then((result) => result.jobs),
  createCronJob: (input: { name: string; prompt: string; schedule: string; enabled?: boolean }) =>
    json<{ job: CronJob }>("/api/cron/jobs", { method: "POST", body: JSON.stringify(input) }).then((result) => result.job),
  updateCronJob: (id: string, input: Partial<Pick<CronJob, "name" | "prompt" | "schedule" | "enabled">>) =>
    json<{ job: CronJob }>(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }).then((result) => result.job),
  deleteCronJob: (id: string) => json<{ ok: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  pauseCronJob: (id: string) => json<{ job: CronJob }>(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, { method: "POST" }).then((result) => result.job),
  resumeCronJob: (id: string) => json<{ job: CronJob }>(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" }).then((result) => result.job),
  triggerCronJob: (id: string) => json<{ job: CronJob; run?: CronRun }>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger`, { method: "POST" }),
  getCronRuns: (id: string) => json<{ runs: CronRun[] }>(`/api/cron/jobs/${encodeURIComponent(id)}/runs`).then((result) => result.runs),

  listSessions: (opts?: { archived?: "only" | "all" }) =>
    json<{ sessions: SessionInfo[]; filter?: string }>(
      opts?.archived === "only"
        ? "/api/sessions?archived=only"
        : opts?.archived === "all"
          ? "/api/sessions?archived=all"
          : "/api/sessions",
    ).then(r => r.sessions),
  createSession: () => json<{ id: string }>("/api/sessions", { method: "POST" }).then(r => r.id),
  /** Soft-archive or restore. Messages stay for hybrid memory until permanent delete. */
  forkSession: (id: string, opts?: { messageId?: string }) =>
    json<{ id: string; session: SessionInfo; messageCount?: number }>(
      `/api/sessions/${encodeURIComponent(id)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(opts?.messageId ? { messageId: opts.messageId } : {}),
      },
    ),
  /** Continue the task in a clean context window without duplicating history. */
  continueSession: (id: string) =>
    json<{
      id: string;
      session: SessionInfo;
      messageCount?: number;
      packet?: {
        sourceSessionId: string;
        createdAt: string;
        verifiedMutationCount: number;
        hasRollingSummary: boolean;
      };
    }>(`/api/sessions/${encodeURIComponent(id)}/continue`, { method: "POST" }),
  setSessionArchived: (id: string, archived: boolean) =>
    json<{ ok: boolean; session?: SessionInfo; curator?: Record<string, unknown> }>(
      `/api/sessions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ archived }),
      },
    ),

  /** Distill session into notes / MEMORY / LTM / handoff catalogs. */
  curateSessionMemory: (
    id: string,
    opts?: { applyMode?: "propose" | "apply_safe" | "apply_all" },
  ) =>
    json<{
      ok: boolean;
      sessionId?: string;
      via?: string;
      applied?: string[];
      summary?: string;
      proposalPath?: string;
      handoffPath?: string;
      modelSource?: string;
      error?: string;
    }>(`/api/sessions/${encodeURIComponent(id)}/curate-memory`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),

  /** Curate many sessions (default: all archived). */
  curateSessionMemoryBatch: (opts?: {
    sessionIds?: string[];
    applyMode?: "propose" | "apply_safe" | "apply_all";
  }) =>
    json<{
      ok: boolean;
      count: number;
      succeeded: number;
      results: Array<{
        sessionId: string;
        ok: boolean;
        applied?: string[];
        via?: string;
        summary?: string;
        error?: string;
        modelSource?: string;
      }>;
    }>("/api/memory/curator/batch", {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),

  listCuratorProposals: (limit = 40) =>
    json<{
      proposals: Array<{
        fileName: string;
        path: string;
        sessionId: string;
        title?: string;
        via?: string;
        applyMode?: string;
        status?: string;
        at?: string;
        applied?: string[];
        proposalCount: number;
        preview: Array<{ target: string; rationale?: string; contentPreview: string }>;
      }>;
    }>(`/api/memory/curator/proposals?limit=${limit}`),

  applyCuratorProposal: (
    fileName: string,
    applyMode: "apply_safe" | "apply_all" = "apply_safe",
  ) =>
    json<{
      ok: boolean;
      sessionId?: string;
      applied?: string[];
      path?: string;
      error?: string;
    }>("/api/memory/curator/proposals/apply", {
      method: "POST",
      body: JSON.stringify({ fileName, applyMode }),
    }),
  /** Durable multi-provider usage summary (accounting; no secrets). */
  getUsageSummary: (days = 30) =>
    json<UsageSummary>(`/api/usage?days=${encodeURIComponent(String(days))}`),
  getUsageBudget: () => json<UsageBudgetSnapshot>("/api/usage/budget"),
  getUsageEvents: (limit = 200) =>
    json<{ events: UsageLedgerEvent[] }>(
      `/api/usage/events?limit=${encodeURIComponent(String(limit))}`,
    ).then((r) => r.events),

  getAccessControl: () => json<AccessControlPublic>("/api/access-tokens"),
  getAccessTokenUsage: (days = 30) => json<{ days: number; principals: AccessTokenUsage[] }>(
    `/api/access-tokens/usage?days=${encodeURIComponent(String(days))}`,
  ),
  getCompanyGateway: () => json<CompanyGatewayInfo>("/api/company-gateway"),
  createAccessToken: (input: {
    label?: string;
    budgetWindow?: "day" | "month";
    softCostUsd?: number | null;
    hardCostUsd?: number | null;
    softTokens?: number | null;
    hardTokens?: number | null;
    allowedModels?: string[];
    expiresAt?: string | null;
  }) =>
    json<{ principal: AccessPrincipal; token: string; accessControl: AccessControlPublic }>(
      "/api/access-tokens",
      { method: "POST", body: JSON.stringify(input) },
    ),
  setAccessControlRequireToken: (requireToken: boolean) =>
    json<AccessControlPublic>("/api/access-tokens", {
      method: "PUT",
      body: JSON.stringify({ requireToken }),
    }),
  patchAccessToken: (id: string, patch: Omit<Partial<AccessPrincipal>, "expiresAt"> & {
    budgetWindow?: "day" | "month";
    expiresAt?: string | null;
  }) =>
    json<{ principal: AccessPrincipal; accessControl: AccessControlPublic }>(
      `/api/access-tokens/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),
  deleteAccessToken: (id: string) =>
    json<{ ok: boolean; accessControl: AccessControlPublic }>(
      `/api/access-tokens/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  regenerateAccessToken: (id: string) =>
    json<{ principal: AccessPrincipal; token: string; accessControl: AccessControlPublic }>(
      `/api/access-tokens/${encodeURIComponent(id)}/regenerate`,
      { method: "POST", body: "{}" },
    ),

  deleteSession: (id: string) => json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) =>
    json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  setSessionModel: (id: string, providerId: string, modelId: string) =>
    json<{ session: SessionInfo }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ providerId, modelId }),
    }).then((result) => result.session),
  setSessionCodingMode: (id: string, codingMode: "auto" | "plan" | "build" | "polish" | "deepreep") =>
    json<{ ok: boolean; session?: SessionInfo }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ codingMode }),
    }),
  getMessages: (id: string) =>
    json<{ messages: import("./types").StoredChatMessage[] }>(
      `/api/sessions/${encodeURIComponent(id)}/messages`,
    ).then(r => r.messages),

  /** Import a foreign/Kyrei conversation export into handoff memory (+ optional seed session). */
  importTranscript: (input: {
    fileName: string;
    contentBase64: string;
    adapterId?: string;
    options?: {
      createSession?: boolean;
      writeLtm?: boolean;
      writeHandoff?: boolean;
      dedupe?: boolean;
      sessionTitle?: string;
    };
  }) =>
    json<{
      report: {
        adapterId: string;
        source: string;
        messageCount: number;
        redactionCount: number;
        contentDigest: string;
        handoffPath?: string;
        handoffId?: string;
        sessionId?: string;
        deduped?: boolean;
        warnings: string[];
        durationMs: number;
      };
      handoffId?: string;
      sessionId?: string;
    }>("/api/import/transcript", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  respondToApproval: (
    session: string,
    approvalId: string,
    approved: boolean,
    opts?: { reason?: string; always?: boolean },
  ) =>
    json<{
      status: "pending" | "streaming";
      approval: import("./types").ApprovalPart;
      promotedRule?: { pattern: string; action: string };
    }>(
      `/api/sessions/${encodeURIComponent(session)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          approved,
          ...(opts?.reason ? { reason: opts.reason } : {}),
          ...(opts?.always ? { always: true } : {}),
        }),
      },
    ),

  respondToFileReview: (
    session: string,
    input:
      | boolean
      | {
          accept?: boolean;
          files?: Array<{
            path: string;
            accept?: boolean;
            hunks?: Array<{ id: string; accept: boolean }>;
          }>;
        },
  ) => {
    const body = typeof input === "boolean"
      ? { accept: input }
      : input;
    return json<{
      ok: boolean;
      done?: boolean;
      messageId: string;
      fileReview?: import("./types").FileReviewState;
    }>(`/api/sessions/${encodeURIComponent(session)}/file-review`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  getSessionChanges: (session: string) =>
    json<{
      sessionId: string;
      count: number;
      changes: Array<{
        messageId: string;
        path: string;
        tool: string;
        snapshotId?: string;
        at?: string;
        diffPreview?: string;
      }>;
    }>(`/api/sessions/${encodeURIComponent(session)}/changes`),

  revertAllSessionChanges: (session: string) =>
    json<{
      ok: boolean;
      restoredSnapshots: number;
      restoredFiles: number;
      changeCount: number;
    }>(`/api/sessions/${encodeURIComponent(session)}/revert-all`, {
      method: "POST",
      body: "{}",
    }),

  sendPrompt: (
    session: string,
    text: string,
    modelParams?: ModelParams,
    messageId?: string,
    skillIds?: string[],
    images?: Array<{ name: string; mediaType: string; data: string }>,
  ) =>
    json<{ status: string }>("/api/prompt", {
      method: "POST",
      body: JSON.stringify({
        session,
        text,
        ...(modelParams ? { modelParams } : {}),
        ...(messageId ? { messageId } : {}),
        ...(skillIds?.length ? { skillIds } : {}),
        ...(images?.length ? { images } : {}),
      }),
    }),
  rewindSession: (session: string, messageId: string) =>
    json<{
      ok: boolean;
      session_id: string;
      draft: string;
      messages: import("./types").StoredChatMessage[];
      restoredSnapshots: number;
      restoredFiles: number;
    }>(`/api/sessions/${encodeURIComponent(session)}/rewind`, {
      method: "POST",
      body: JSON.stringify({ messageId }),
    }),
  cancel: (session: string) => json<{
    ok: boolean;
    status: "idle" | "interrupted" | "cancelled" | "timeout";
    message_id?: string;
  }>("/api/cancel", { method: "POST", body: JSON.stringify({ session }) }),

  listFiles: (path = "") =>
    json<{ root: string; path: string; entries: { name: string; path: string; dir: boolean }[] }>(
      `/api/files?path=${encodeURIComponent(path)}`,
    ),
  readFile: (path: string) =>
    json<{ path: string; content: string; truncated?: boolean }>(`/api/file?path=${encodeURIComponent(path)}`),

  /** Known engine models for the picker (degrades to [] → manual entry). */
  getModels: () =>
    json<{ models: ModelCatalogEntry[]; current: string; provider: string }>("/api/models"),

  /** Jail-safe path autocompletion for @-mentions. */
  completePath: (path: string) =>
    json<{ entries: { name: string; path: string; dir: boolean }[] }>("/api/complete-path", {
      method: "POST",
      body: JSON.stringify({ path }),
    }).then(r => r.entries),

  /** Subscribe to a session's event stream. Returns an unsubscribe function. */
  subscribe(session: string, onEvent: (event: GatewayEvent) => void): () => void {
    if (!GATEWAY_TOKEN) throw new GatewayRequestError("capability_unavailable");
    const url = new URL(`${BASE}/api/events`);
    url.searchParams.set("session", session);
    // EventSource cannot send custom headers, so its scoped stream uses the
    // same per-launch capability in a query value accepted only on this route.
    url.searchParams.set("token", GATEWAY_TOKEN);
    const es = new EventSource(url.href);
    es.onmessage = e => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore keepalive/comments */ }
    };
    es.onerror = () => { /* EventSource reconnects automatically. */ };
    return () => es.close();
  },
};
