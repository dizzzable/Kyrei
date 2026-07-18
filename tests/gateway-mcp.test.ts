import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

describe("gateway MCP diagnostics", () => {
  let dataDir = "";
  let server: { port: number; token: string; close(): Promise<void> };
  const close = vi.fn(async () => undefined);
  const normalizeMcpConfig = vi.fn((raw: Record<string, unknown>) => ({
    enabled: raw.enabled === true,
    servers: Array.isArray(raw.servers) ? raw.servers : [],
    timeoutMs: 30_000,
    maxServers: 8,
    maxToolsPerServer: 64,
    maxResultChars: 24_000,
  }));
  const createMcpManager = vi.fn((input: { config: { servers: Array<{ id: string; command?: string; source?: "global" | "project" }> } }) => ({
    inspectServers: async () => input.config.servers.map((server) => ({
      id: server.id,
      command: server.command ?? "",
      ...(server.source ? { source: server.source } : {}),
      ok: true,
      toolCount: 3,
    })),
    close,
  }));

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-mcp-"));
    close.mockClear();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: vi.fn(),
        normalizeMcpConfig,
        createMcpManager,
      }),
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `${response.status}`);
    return body;
  }

  it("reports configured MCP servers and exercises a real list-tools handshake", async () => {
    const current = await request<{ engine?: Record<string, unknown> }>("/api/config");
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        engine: {
          ...(current.engine ?? {}),
          mcp: { enabled: true, servers: [{ id: "filesystem", command: "npx" }] },
        },
      }),
    });
    const status = await request<{
      enabled: boolean;
      state: string;
      servers: Array<{ id: string; toolCount: number; ok: boolean }>;
    }>("/api/memory/mcp");
    expect(status).toMatchObject({
      enabled: true,
      state: "ready",
      servers: [{ id: "filesystem", command: "npx", source: "global", ok: true, toolCount: 3 }],
    });
    expect(createMcpManager).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("loads a trusted project MCP file beside global servers without leaking it to another workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-gateway-mcp-workspace-"));
    try {
      await mkdir(join(workspace, ".kyrei"));
      await writeFile(join(workspace, ".kyrei", "mcp.json"), JSON.stringify({
        version: 1,
        enabled: true,
        servers: [{ id: "project-db", command: "node" }],
      }), "utf8");
      const current = await request<{ engine?: Record<string, unknown> }>("/api/config");
      await request("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          workspace,
          engine: {
            ...(current.engine ?? {}),
            mcp: { enabled: true, servers: [{ id: "global-docs", command: "npx" }] },
          },
        }),
      });

      const beforeTrust = await request<{
        enabled: boolean;
        servers: Array<{ id: string }>;
        project: { exists: boolean; trusted: boolean };
      }>("/api/memory/mcp");
      expect(beforeTrust.project.exists).toBe(true);
      expect(beforeTrust.project.trusted).toBe(false);
      expect(beforeTrust.servers.map((server) => server.id)).toEqual(["global-docs"]);

      const trusted = await request<{ trusted: boolean }>("/api/mcp/project/trust", {
        method: "POST",
        body: JSON.stringify({ trusted: true }),
      });
      expect(trusted.trusted).toBe(true);

      const afterTrust = await request<{
        servers: Array<{ id: string; source?: string }>;
        project: { trusted: boolean };
      }>("/api/memory/mcp");
      expect(afterTrust.project.trusted).toBe(true);
      expect(afterTrust.servers).toEqual([
        { id: "global-docs", command: "npx", source: "global", ok: true, toolCount: 3 },
        { id: "project-db", command: "node", source: "project", ok: true, toolCount: 3 },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
