import type {
  AppConfig,
  ChatMessage,
  CronJob,
  CronRun,
  GatewayEvent,
  GatewayStatus,
  KiroCliConnectorStatus,
  KiroCliLoginInput,
  KiroCliLoginSnapshot,
  KiroCliModelCatalog,
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
} from "./types";

/** A model entry from the engine registry (`GET /api/models`). */
export interface ModelCatalogEntry {
  id: string;
  name?: string;
  provider: string;
  providerName?: string;
  baseURL: string;
  limits?: { contextWindow: number; maxOutput: number };
  cost?: { inputPerM: number; outputPerM: number };
  caps?: { tools: boolean; reasoning: boolean; streaming: boolean; vision: boolean };
}

/** Per-turn reasoning/effort tuning forwarded to the engine. */
export interface ModelParams {
  effort?: string;
  fast?: boolean;
  reasoning?: boolean;
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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Kyrei-Gateway-Token": GATEWAY_TOKEN, ...(init?.headers || {}) },
  });
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

  getConfig: () => json<AppConfig>("/api/config"),
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
  }>) =>
    json<AppConfig>("/api/config", { method: "PUT", body: JSON.stringify(patch) }),
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
  discoverSavedProvider: (id: string, options: { allowBenchmarkNetwork?: boolean } = {}) =>
    json<ProviderDiscoveryResult>(`/api/providers/${encodeURIComponent(id)}/discover`, {
      method: "POST",
      body: JSON.stringify({ allowBenchmarkNetwork: options.allowBenchmarkNetwork === true }),
    }),
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

  listSessions: () => json<{ sessions: SessionInfo[] }>("/api/sessions").then(r => r.sessions),
  createSession: () => json<{ id: string }>("/api/sessions", { method: "POST" }).then(r => r.id),
  deleteSession: (id: string) => json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) =>
    json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  setSessionModel: (id: string, providerId: string, modelId: string) =>
    json<{ session: SessionInfo }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ providerId, modelId }),
    }).then((result) => result.session),
  getMessages: (id: string) =>
    json<{ messages: { role: ChatMessage["role"]; content: string; parts?: import("./types").MessagePart[] }[] }>(
      `/api/sessions/${encodeURIComponent(id)}/messages`,
    ).then(r => r.messages),

  sendPrompt: (session: string, text: string, modelParams?: ModelParams) =>
    json<{ status: string }>("/api/prompt", { method: "POST", body: JSON.stringify({ session, text, ...(modelParams ? { modelParams } : {}) }) }),
  cancel: (session: string) => json<{ ok: boolean }>("/api/cancel", { method: "POST", body: JSON.stringify({ session }) }),

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
