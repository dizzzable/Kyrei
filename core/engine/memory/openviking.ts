/**
 * Narrow optional HTTP adapter for a user-managed local OpenViking service.
 *
 * Kyrei does not vendor OpenViking's AGPLv3 server. This client only talks to
 * a service the user has explicitly started (normally through the supplied
 * loopback-only Docker Compose file), keeping Kyrei's built-in SQLite memory
 * independent and usable without Docker.
 */

export interface OpenVikingResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type OpenVikingFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<OpenVikingResponse>;

export interface OpenVikingOptions {
  baseURL?: string;
  apiKey?: string;
  /** Remote servers are never used unless a caller intentionally opts in. */
  allowRemote?: boolean;
  timeoutMs?: number;
  fetch?: OpenVikingFetch;
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeBaseURL(raw: string, allowRemote: boolean): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OpenViking URL must use http or https");
  if (url.username || url.password) throw new Error("OpenViking URL must not contain credentials");
  if (!allowRemote && !isLoopback(url.hostname)) throw new Error("OpenViking must use a loopback URL unless remote access is explicitly enabled");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function nativeFetch(url: string, init: Parameters<OpenVikingFetch>[1]): Promise<OpenVikingResponse> {
  return fetch(url, init) as Promise<OpenVikingResponse>;
}

export interface OpenVikingClient {
  health(): Promise<unknown>;
  find(query: string): Promise<unknown>;
  addMessage(sessionId: string, role: "user" | "assistant", content: string): Promise<unknown>;
  commitSession(sessionId: string): Promise<unknown>;
}

export function createOpenVikingClient(options: OpenVikingOptions = {}): OpenVikingClient {
  const baseURL = normalizeBaseURL(options.baseURL ?? "http://127.0.0.1:1933", options.allowRemote === true);
  const fetchImpl = options.fetch ?? nativeFetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const request = async (method: "GET" | "POST", path: string, payload?: unknown, authenticated = true): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(path.replace(/^\//, ""), `${baseURL.href.replace(/\/$/, "")}/`);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated && options.apiKey) headers["X-API-Key"] = options.apiKey;
    try {
      const response = await fetchImpl(url.href, {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`OpenViking returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }
      return response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error("OpenViking request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    health: () => request("GET", "/health", undefined, false),
    find: (query) => request("POST", "/api/v1/search/find", { query }),
    addMessage: (sessionId, role, content) => request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, { role, content }),
    commitSession: (sessionId) => request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`),
  };
}
