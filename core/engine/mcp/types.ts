/**
 * Minimal MCP (Model Context Protocol) client types.
 * Spec-aligned subset: tools/list + tools/call over stdio or Streamable HTTP.
 */

export interface McpServerConfig {
  /** Stable id used in tool calls (e.g. "filesystem"). */
  id: string;
  /** stdio is the backwards-compatible default for existing config files. */
  transport?: "stdio" | "streamable-http" | "unsupported";
  /** Executable to spawn (absolute path or PATH name), stdio only. */
  command?: string;
  args?: string[];
  /** Extra env vars (never inherit secrets from renderer). */
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP endpoint, HTTP transport only. */
  url?: string;
  /** Explicit headers for a user-managed HTTP server. Values are redacted from diagnostics. */
  headers?: Record<string, string>;
  /** Preserved invalid/custom transport so Settings can explain it instead of dropping it. */
  configuredTransport?: string;
  reason?: string;
  enabled?: boolean;
  /** Configuration layer selected this server from. Never accepted as authority from a tool. */
  source?: "global" | "project";
}

export interface McpConfig {
  enabled: boolean;
  servers: McpServerConfig[];
  /** Per-request timeout for list/call (ms). */
  timeoutMs: number;
  maxServers: number;
  maxToolsPerServer: number;
  /** Max tool result characters returned to the model. */
  maxResultChars: number;
  /** Canonical workspaces whose repository MCP file the user explicitly approved. */
  projectTrust?: string[];
}

export interface McpToolInfo {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  ok: boolean;
  serverId: string;
  tool: string;
  content?: string;
  isError?: boolean;
  error?: string;
}

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: false,
  servers: [],
  timeoutMs: 30_000,
  maxServers: 8,
  maxToolsPerServer: 64,
  maxResultChars: 24_000,
  projectTrust: [],
};
