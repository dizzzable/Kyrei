import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

const builtinStatus = {
  state: "ready",
  host: "127.0.0.1",
  port: 54_321,
  vector: true,
  connectionString: "postgresql://postgres@127.0.0.1:54321/postgres?sslmode=disable",
} as const;

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };
let localPostgres: {
  ensure: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-local-postgres-"));
  localPostgres = {
    ensure: vi.fn(async () => builtinStatus),
    getStatus: vi.fn(() => ({ state: "stopped", host: "127.0.0.1", port: 0, vector: false })),
    close: vi.fn(async () => undefined),
  };
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    localPostgres,
    engineLoader: async () => ({ runKyreiChat: vi.fn(), listModels: () => [] }),
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

function teamConfig() {
  return {
    defaultMode: "team",
    activeProfileId: "local-team",
    profiles: [{
      id: "local-team",
      name: "Local team",
      workflow: "supervisor",
      enabled: true,
      roles: [{
        id: "reviewer",
        name: "Reviewer",
        description: "Review the proposed implementation",
        instructions: "Return evidence and concerns.",
        skillIds: [],
        capabilities: ["workspace.read"],
        canSpawn: false,
        maxChildren: 0,
      }],
      limits: {
        maxParallel: 2,
        maxDepth: 1,
        maxAgents: 4,
        maxTasks: 4,
        maxStepsPerAgent: 4,
        timeoutMs: 60_000,
      },
    }],
  };
}

async function makeMainProviderReady() {
  const config = await request<{ activeProviderId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "test-main-credential" }),
  });
}

describe("gateway embedded Team Postgres", () => {
  it("starts and wires the built-in database when Team mode is enabled", async () => {
    await makeMainProviderReady();

    const saved = await request<any>("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: teamConfig() }),
    });

    expect(localPostgres.ensure).toHaveBeenCalledTimes(1);
    expect(saved.engine.memory.index).toMatchObject({
      enabled: true,
      backend: "postgres",
      connectionString: builtinStatus.connectionString,
      connectionSource: "builtin",
    });
    expect(await request("/api/memory/local-postgres")).toMatchObject({ state: "stopped" });
    expect(await request("/api/memory/local-postgres/ensure", { method: "POST" })).toEqual(builtinStatus);
  });

  it("keeps an operator-managed Postgres connection untouched", async () => {
    await makeMainProviderReady();
    const config = await request<any>("/api/config");
    const externalConnection = "postgresql://kyrei@db.example:5432/team";

    const saved = await request<any>("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        engine: {
          ...config.engine,
          memory: {
            ...(config.engine?.memory ?? {}),
            index: {
              enabled: true,
              backend: "postgres",
              connectionString: externalConnection,
              connectionSource: "external",
            },
          },
        },
        orchestration: teamConfig(),
      }),
    });

    expect(localPostgres.ensure).not.toHaveBeenCalled();
    expect(saved.engine.memory.index).toMatchObject({
      backend: "postgres",
      connectionString: externalConnection,
      connectionSource: "external",
    });
  });
});
