import type { AppConfig, ChatMessage, GatewayEvent, ProviderCredentialsInput, ProviderProfile, SessionInfo } from "./types";

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

const launchParams = new URLSearchParams(location.search);

function resolveBase(): string {
  const port = launchParams.get("port") || "8765";
  return `http://127.0.0.1:${port}`;
}

const BASE = resolveBase();
const GATEWAY_TOKEN = launchParams.get("gatewayToken") || "";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  if (!GATEWAY_TOKEN) throw new Error("Kyrei gateway capability is unavailable. Restart the desktop app.");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Kyrei-Gateway-Token": GATEWAY_TOKEN, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

export const gateway = {
  base: BASE,

  getConfig: () => json<AppConfig>("/api/config"),
  setConfig: (patch: Partial<{
    provider: string;
    apiKey: string;
    clearApiKey: boolean;
    model: string;
    activeModelId: string;
    activeProviderId: string;
    providers: ProviderProfile[];
    workspace: string;
    engine: Record<string, unknown>;
  }>) =>
    json<AppConfig>("/api/config", { method: "PUT", body: JSON.stringify(patch) }),
  getProviders: () => json<{ providers: ProviderProfile[]; activeProviderId: string; activeModelId: string }>("/api/providers"),
  createProvider: (provider: Partial<ProviderProfile>, apiKey?: string, activate = true) =>
    json<AppConfig>("/api/providers", { method: "POST", body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}), activate }) }),
  updateProvider: (id: string, provider: Partial<ProviderProfile>) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ provider }) }),
  deleteProvider: (id: string) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setProviderSecret: (id: string, credentials: ProviderCredentialsInput | string) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}/secret`, {
      method: "PUT",
      body: JSON.stringify(typeof credentials === "string" ? { apiKey: credentials } : { credentials }),
    }),
  clearProviderSecret: (id: string) =>
    json<AppConfig>(`/api/providers/${encodeURIComponent(id)}/secret`, { method: "DELETE" }),
  chooseFolder: () => json<{ folder: string } & AppConfig>("/api/choose-folder", { method: "POST" }),

  listSessions: () => json<{ sessions: SessionInfo[] }>("/api/sessions").then(r => r.sessions),
  createSession: () => json<{ id: string }>("/api/sessions", { method: "POST" }).then(r => r.id),
  deleteSession: (id: string) => json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) =>
    json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
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
    if (!GATEWAY_TOKEN) throw new Error("Kyrei gateway capability is unavailable. Restart the desktop app.");
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
