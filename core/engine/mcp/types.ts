/**
 * Minimal MCP (Model Context Protocol) client types.
 * Spec-aligned subset: tools/list + tools/call over stdio.
 */

export interface McpServerConfig {
  /** Stable id used in tool calls (e.g. "filesystem"). */
  id: string;
  /** Executable to spawn (absolute path or PATH name). */
  command: string;
  args?: string[];
  /** Extra env vars (never inherit secrets from renderer). */
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
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
};
