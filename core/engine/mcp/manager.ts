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
  /** Workspace-owned default for stdio servers that do not define a cwd. */
  workspace?: string;
  sensitiveValues?: readonly string[];
  createClient?: (server: McpServerConfig, timeoutMs: number) => McpClient;
}

export interface McpClient {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * How long one manager reuses a tool catalog. Long enough that paging through
 * `mcp_list_tools` costs one fan-out instead of one per page, short enough that
 * a server whose tool set changes mid-run is picked up within the same turn.
 */
const CATALOG_CACHE_MS = 30_000;

/** Sentinel entry standing in for a server whose tool listing failed. */
const LIST_FAILED_TOOL = "__error__";

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
    const source = s.source === "project" ? "project" : s.source === "global" ? "global" : undefined;
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
            ...(source ? { source } : {}),
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
          ...(source ? { source } : {}),
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
    ...(Array.isArray(raw?.projectTrust)
      ? { projectTrust: raw.projectTrust.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 128) }
      : {}),
  };
}

export function createMcpManager(options: McpManagerOptions) {
  const normalized = normalizeMcpConfig(options.config);
  const workspace = typeof options.workspace === "string" ? options.workspace.trim() : "";
  const config: McpConfig = workspace
    ? {
        ...normalized,
        servers: normalized.servers.map((server) => (
          server.transport === "stdio" && !server.cwd
            ? { ...server, cwd: workspace }
            : server
        )),
      }
    : normalized;
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

  /**
   * Catalog cache.
   *
   * `mcp_list_tools` is paginated, and every page used to re-list every server
   * from scratch — so paging through a catalog cost N server round-trips per
   * page. The cache is per-manager, and a manager lives for one run, so it can
   * never leak one workspace's catalog into another.
   *
   * There is deliberately no invalidation on tool-set change: MCP's
   * `notifications/tools/list_changed` is not wired, so the only bound is the
   * TTL. Failures are never cached (see `listTools`), which is what matters —
   * a stale success for 30s is harmless, a stale failure hides a server.
   */
  let catalogCache: { at: number; tools: McpToolInfo[] } | null = null;

  function invalidateCatalog(): void {
    catalogCache = null;
  }

  async function listTools(): Promise<McpToolInfo[]> {
    if (!config.enabled) return [];
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_CACHE_MS) return catalogCache.tools;
    // Concurrent, not sequential: awaiting each server in turn meant
    // `maxServers` × `timeoutMs` (8 × 30s) could elapse inside ONE tool call
    // while the model waited. Servers are independent, so nothing is ordered
    // between them — only the output is, and that is restored by the sort.
    const perServer = await Promise.all(config.servers.map(async (server) => {
      try {
        const tools = await getClient(server.id).listTools();
        return tools.slice(0, config.maxToolsPerServer).map((t) => ({
          serverId: server.id,
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
        }));
      } catch (error) {
        return [{
          serverId: server.id,
          name: LIST_FAILED_TOOL,
          description: `Failed to list tools: ${(error as Error).message}`,
        }];
      }
    }));
    // Preserve configured server order so the catalog and its page offsets are
    // stable across calls regardless of which server answered first.
    const out = perServer.flat();
    // Never cache a failure: a stdio server that loses the race with its own
    // spawn (npx-based ones routinely do) would otherwise stay invisible to the
    // model for the whole TTL, and the pre-cache code retried on the next call.
    if (!out.some((entry) => entry.name === LIST_FAILED_TOOL)) {
      catalogCache = { at: Date.now(), tools: out };
    }
    // Hand out a copy: the only consumer sorts the result in place, which would
    // otherwise permanently reorder the cache this function just promised was
    // in configured order.
    return out.slice();
  }

  /** Explicit diagnostics used by Settings; unlike listTools it preserves one
   * stable result per configured server and includes startup failures. */
  async function inspectServers(): Promise<Array<{
    id: string;
    command: string;
    transport: "stdio" | "streamable-http" | "unsupported";
    source?: "global" | "project";
    ok: boolean;
    toolCount: number;
    error?: string;
  }>> {
    if (!config.enabled) return [];
    // Concurrent for the same reason as listTools: this backs the Settings
    // diagnostics panel, which hung for the sum of every server's timeout.
    // Never cached — its whole purpose is to report live health.
    return await Promise.all(config.servers.map(async (server) => {
      const identity = {
        id: server.id,
        command: server.command ?? server.url ?? "",
        transport: server.transport ?? "stdio",
        ...(server.source ? { source: server.source } : {}),
      };
      try {
        const tools = await getClient(server.id).listTools();
        return { ...identity, ok: true, toolCount: tools.length };
      } catch (error) {
        return { ...identity, ok: false, toolCount: 0, error: (error as Error).message };
      }
    }));
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
    invalidateCatalog();
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
