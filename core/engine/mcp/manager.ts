/**
 * MCP server manager: lazy stdio clients, bounded list/call, fail-open close.
 */

import { McpHttpClient } from "./http-client.js";
import { McpStdioClient } from "./stdio-client.js";
import type { McpCallResult, McpConfig, McpServerConfig, McpToolInfo } from "./types.js";
import { DEFAULT_MCP_CONFIG } from "./types.js";
import { redact } from "../security/secrets.js";

export interface McpManagerOptions {
  config: McpConfig;
  sensitiveValues?: readonly string[];
  createClient?: (server: McpServerConfig, timeoutMs: number) => McpClient;
}

export interface McpClient {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function sanitizeServerId(id: string): string {
  return id.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

export function normalizeMcpConfig(raw: Partial<McpConfig> | undefined): McpConfig {
  const base = DEFAULT_MCP_CONFIG;
  const serversIn = Array.isArray(raw?.servers) ? raw!.servers : [];
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const s of serversIn.slice(0, raw?.maxServers ?? base.maxServers)) {
    if (!s || typeof s !== "object") continue;
    const id = sanitizeServerId(String(s.id ?? ""));
    if (!id || seen.has(id)) continue;
    if (s.enabled === false) continue;
    seen.add(id);
    const requestedTransport = typeof s.transport === "string" ? s.transport.trim().toLowerCase() : "stdio";
    if (requestedTransport === "streamable-http") {
      const url = typeof s.url === "string" ? s.url.trim() : "";
      let validUrl = false;
      try {
        const parsed = new URL(url);
        validUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch { /* retained below as a diagnostic */ }
      servers.push(validUrl
        ? {
            id,
            transport: "streamable-http",
            url,
            ...(s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)
              ? { headers: Object.fromEntries(Object.entries(s.headers).filter(([k, v]) => typeof k === "string" && typeof v === "string").slice(0, 32)) }
              : {}),
            enabled: true,
          }
        : { id, transport: "unsupported", configuredTransport: requestedTransport, reason: "mcp_url_invalid", enabled: true });
      continue;
    }
    const command = typeof s.command === "string" ? s.command.trim() : "";
    if (requestedTransport !== "stdio") {
      servers.push({ id, transport: "unsupported", configuredTransport: requestedTransport || "unknown", reason: "transport_unsupported", enabled: true });
      continue;
    }
    servers.push(command
      ? {
          id,
          transport: "stdio",
          command,
          ...(Array.isArray(s.args) ? { args: s.args.map(String).slice(0, 32) } : {}),
          ...(s.env && typeof s.env === "object" && !Array.isArray(s.env)
            ? { env: Object.fromEntries(Object.entries(s.env).filter(([k, v]) => typeof k === "string" && typeof v === "string").slice(0, 64)) }
            : {}),
          ...(typeof s.cwd === "string" && s.cwd.trim() ? { cwd: s.cwd.trim() } : {}),
          enabled: true,
        }
      : { id, transport: "unsupported", configuredTransport: "stdio", reason: "mcp_command_required", enabled: true });
  }
  return {
    enabled: raw?.enabled === true,
    servers,
    timeoutMs: Math.min(300_000, Math.max(1_000, raw?.timeoutMs ?? base.timeoutMs)),
    maxServers: Math.min(16, Math.max(1, raw?.maxServers ?? base.maxServers)),
    maxToolsPerServer: Math.min(200, Math.max(1, raw?.maxToolsPerServer ?? base.maxToolsPerServer)),
    maxResultChars: Math.min(200_000, Math.max(1_000, raw?.maxResultChars ?? base.maxResultChars)),
  };
}

export function createMcpManager(options: McpManagerOptions) {
  const config = normalizeMcpConfig(options.config);
  const clients = new Map<string, McpClient>();
  const create =
    options.createClient
    ?? ((server: McpServerConfig, timeoutMs: number): McpClient => {
      if (server.transport === "streamable-http") return new McpHttpClient({ server, timeoutMs });
      if (server.transport === "stdio" || !server.transport) return new McpStdioClient({ server, timeoutMs });
      throw new Error(`${server.reason ?? "transport_unsupported"}:${server.configuredTransport ?? "unknown"}`);
    });

  function getClient(serverId: string): McpClient {
    const id = sanitizeServerId(serverId);
    const existing = clients.get(id);
    if (existing) return existing;
    const server = config.servers.find((s) => s.id === id);
    if (!server) throw new Error(`mcp_server_unknown:${id}`);
    const client = create(server, config.timeoutMs);
    clients.set(id, client);
    return client;
  }

  async function listTools(): Promise<McpToolInfo[]> {
    if (!config.enabled) return [];
    const out: McpToolInfo[] = [];
    for (const server of config.servers) {
      try {
        const client = getClient(server.id);
        const tools = await client.listTools();
        for (const t of tools.slice(0, config.maxToolsPerServer)) {
          out.push({
            serverId: server.id,
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
          });
        }
      } catch (error) {
        out.push({
          serverId: server.id,
          name: "__error__",
          description: `Failed to list tools: ${(error as Error).message}`,
        });
      }
    }
    return out;
  }

  /** Explicit diagnostics used by Settings; unlike listTools it preserves one
   * stable result per configured server and includes startup failures. */
  async function inspectServers(): Promise<Array<{
    id: string;
    command: string;
    transport: "stdio" | "streamable-http" | "unsupported";
    ok: boolean;
    toolCount: number;
    error?: string;
  }>> {
    if (!config.enabled) return [];
    const out = [];
    for (const server of config.servers) {
      try {
        const tools = await getClient(server.id).listTools();
        out.push({ id: server.id, command: server.command ?? server.url ?? "", transport: server.transport ?? "stdio", ok: true, toolCount: tools.length });
      } catch (error) {
        out.push({
          id: server.id,
          command: server.command ?? server.url ?? "",
          transport: server.transport ?? "stdio",
          ok: false,
          toolCount: 0,
          error: (error as Error).message,
        });
      }
    }
    return out;
  }

  function formatCallResult(raw: unknown): string {
    if (raw == null) return "";
    if (typeof raw === "string") return raw;
    // MCP tools/call result shape: { content: [{ type: "text", text }], isError? }
    if (typeof raw === "object" && raw && "content" in (raw as object)) {
      const content = (raw as { content?: unknown }).content;
      if (Array.isArray(content)) {
        return content
          .map((c) => {
            if (!c || typeof c !== "object") return "";
            const part = c as { type?: string; text?: string };
            if (part.type === "text" && typeof part.text === "string") return part.text;
            try {
              return JSON.stringify(c);
            } catch {
              return String(c);
            }
          })
          .filter(Boolean)
          .join("\n");
      }
    }
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }

  async function callTool(serverId: string, tool: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    if (!config.enabled) {
      return { ok: false, serverId, tool, error: "mcp_disabled" };
    }
    const id = sanitizeServerId(serverId);
    const name = String(tool ?? "").trim();
    if (!name || name.length > 200) {
      return { ok: false, serverId: id, tool: name, error: "mcp_tool_invalid" };
    }
    try {
      const client = getClient(id);
      const raw = await client.callTool(name, args && typeof args === "object" ? args : {});
      const isError = Boolean(raw && typeof raw === "object" && (raw as { isError?: boolean }).isError);
      let content = formatCallResult(raw);
      content = redact(content, options.sensitiveValues ?? []);
      if (content.length > config.maxResultChars) {
        content = `${content.slice(0, config.maxResultChars)}\n… [mcp output truncated]`;
      }
      return {
        ok: !isError,
        serverId: id,
        tool: name,
        content,
        isError,
      };
    } catch (error) {
      return {
        ok: false,
        serverId: id,
        tool: name,
        error: redact((error as Error).message, options.sensitiveValues ?? []),
      };
    }
  }

  async function close(): Promise<void> {
    const all = [...clients.values()];
    clients.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
  }

  return {
    config,
    listTools,
    inspectServers,
    callTool,
    close,
    serverIds: () => config.servers.map((s) => s.id),
  };
}

export type McpManager = ReturnType<typeof createMcpManager>;
