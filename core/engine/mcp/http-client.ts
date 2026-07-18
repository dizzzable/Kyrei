/**
 * Streamable HTTP MCP client.
 *
 * Implements the request/response subset Kyrei needs for tools/list and
 * tools/call. It follows the transport contract: each JSON-RPC message is a
 * POST, accepts JSON or SSE, carries a negotiated MCP session id when issued,
 * and sends DELETE on close. Server-initiated requests are intentionally out
 * of scope for this bounded tools-only client.
 */

import type { McpServerConfig } from "./types.js";

type FetchLike = typeof fetch;

export interface McpHttpClientOptions {
  server: McpServerConfig;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

function endpoint(server: McpServerConfig): string {
  const value = server.url?.trim();
  if (!value) throw new Error("mcp_url_required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("mcp_url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("mcp_url_invalid");
  return parsed.toString();
}

function jsonFromSse(text: string, requestId: number): unknown {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const value = JSON.parse(data) as { id?: unknown };
      if (Number(value.id) === requestId) return value;
    } catch {
      /* Keep looking for a complete message. */
    }
  }
  throw new Error("mcp_http_sse_response_missing");
}

function responseMessage(body: string, contentType: string, requestId: number): Record<string, unknown> {
  const parsed = contentType.includes("text/event-stream")
    ? jsonFromSse(body, requestId)
    : JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mcp_http_response_invalid");
  return parsed as Record<string, unknown>;
}

function safeSessionId(value: string | null): string | undefined {
  if (!value || value.length > 512 || /[^\x21-\x7e]/.test(value)) return undefined;
  return value;
}

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private nextId = 1;
  private initPromise: Promise<void> | null = null;
  private closed = false;
  private sessionId: string | undefined;
  private protocolVersion = "2025-03-26";

  constructor(private readonly options: McpHttpClientOptions) {
    this.endpoint = endpoint(options.server);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.ensureStarted();
    const result = await this.request("tools/list", {});
    const tools = Array.isArray((result as { tools?: unknown }).tools)
      ? (result as { tools: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> }).tools
      : [];
    return tools
      .filter((tool) => typeof tool?.name === "string" && tool.name.trim())
      .map((tool) => ({
        name: String(tool.name),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureStarted();
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.closed = true;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    this.initPromise = null;
    if (!sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: { "MCP-Session-Id": sessionId, "MCP-Protocol-Version": this.protocolVersion },
        signal: controller.signal,
      });
    } catch {
      /* Session termination is best-effort by the MCP specification. */
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("mcp_client_closed");
    this.initPromise ??= this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "kyrei", version: "2.0.0" },
    }, true);
    const negotiated = (result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof negotiated === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(negotiated)) this.protocolVersion = negotiated;
    await this.notify("notifications/initialized", {});
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, undefined, method, false);
  }

  private async request(method: string, params: unknown, initializing = false): Promise<unknown> {
    const id = this.nextId++;
    const message = await this.post({ jsonrpc: "2.0", id, method, params }, id, method, initializing);
    if (message.error) {
      const error = message.error as { message?: unknown; code?: unknown };
      throw new Error(typeof error?.message === "string" ? error.message : `mcp_error:${String(error?.code ?? "unknown")}`);
    }
    return message.result;
  }

  private async post(message: Record<string, unknown>, id: number | undefined, method: string, initializing: boolean): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Method": method,
      ...(this.options.server.headers ?? {}),
    };
    if (!initializing) headers["MCP-Protocol-Version"] = this.protocolVersion;
    if (this.sessionId && !initializing) headers["MCP-Session-Id"] = this.sessionId;
    if (method === "tools/call" && message.params && typeof message.params === "object") {
      const name = (message.params as { name?: unknown }).name;
      if (typeof name === "string" && name) headers["MCP-Name"] = name;
    }
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (response.status === 404 && this.sessionId && !initializing) {
        // A stateful server ended the session. Re-initialise once, then retry.
        this.sessionId = undefined;
        this.initPromise = null;
        await this.ensureStarted();
        return this.post(message, id, method, false);
      }
      const body = await response.text();
      if (!response.ok) throw new Error(`mcp_http_${response.status}:${body.slice(0, 500)}`);
      const session = safeSessionId(response.headers.get("mcp-session-id"));
      if (initializing && session) this.sessionId = session;
      if (id === undefined) return {};
      return responseMessage(body, response.headers.get("content-type") ?? "application/json", id);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`mcp_timeout:${method}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
