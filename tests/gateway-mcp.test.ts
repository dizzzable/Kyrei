import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

describe("gateway MCP diagnostics", () => {
  let dataDir = "";
  let server: { port: number; token: string; close(): Promise<void> };
  const inspectServers = vi.fn(async () => [
    { id: "filesystem", command: "npx", ok: true, toolCount: 3 },
  ]);
  const close = vi.fn(async () => undefined);
  const normalizeMcpConfig = vi.fn((raw: Record<string, unknown>) => ({
    enabled: raw.enabled === true,
    servers: [{ id: "filesystem", command: "npx", enabled: true }],
    timeoutMs: 30_000,
    maxServers: 8,
    maxToolsPerServer: 64,
    maxResultChars: 24_000,
  }));

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-mcp-"));
    inspectServers.mockClear();
    close.mockClear();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: vi.fn(),
        normalizeMcpConfig,
        createMcpManager: vi.fn(() => ({ inspectServers, close })),
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
    expect(status).toEqual({
      enabled: true,
      state: "ready",
      servers: [{ id: "filesystem", command: "npx", ok: true, toolCount: 3 }],
    });
    expect(inspectServers).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
