import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: Awaited<ReturnType<typeof startGateway>>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-company-gateway-"));
  server = await startGateway({ dataDir, preferredPort: 0 });
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function ownerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) throw new Error(body.error ?? body.code ?? String(response.status));
  return body;
}

async function configureCompanyProviders() {
  await ownerRequest("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providers: [
        {
          id: "openai-pool",
          name: "OpenAI pool",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:19101/v1",
          requiresApiKey: false,
          models: [{ id: "gpt-main" }, { id: "gpt-review" }],
        },
        {
          id: "anthropic-pool",
          name: "Anthropic pool",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:19102/v1",
          requiresApiKey: false,
          models: [{ id: "claude-main" }],
        },
      ],
      activeProviderId: "openai-pool",
      activeModelId: "gpt-main",
    }),
  });
}

describe("company LAN gateway", () => {
  it("shows only the models explicitly assigned to an employee key", async () => {
    await configureCompanyProviders();
    const created = await ownerRequest<{ token: string; principal: { id: string; allowedModels?: string[] } }>("/api/access-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "Vasya",
        allowedModels: ["anthropic-pool/claude-main"],
      }),
    });

    expect(created.principal.allowedModels).toEqual(["anthropic-pool/claude-main"]);

    const usage = await ownerRequest<{ principals: Array<{ id: string; requestCount: number; totalTokens: number }> }>(
      "/api/access-tokens/usage?days=7",
    );
    expect(usage.principals).toContainEqual({ id: created.principal.id, requestCount: 0, totalTokens: 0, costUsd: 0 });

    const catalog = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(catalog.status).toBe(200);
    const listed = await catalog.json() as { data: Array<{ id: string }> };
    expect(listed.data.map((row) => row.id)).toEqual(["anthropic-pool/claude-main"]);

    const denied = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai-pool/gpt-main",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: "access_token_model_not_allowed" });
  });

  it("rejects expired employee keys before exposing the model catalog", async () => {
    const created = await ownerRequest<{ token: string }>("/api/access-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Expired", expiresAt: "2020-01-01T00:00:00.000Z" }),
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "access_token_expired" });
  });

  it("gives the owner a copyable local connection contract without secrets", async () => {
    const response = await ownerRequest<{
      proxy: { enabled: boolean; listenLan: boolean; restartRequired: boolean };
      endpoints: Array<{ baseUrl: string; kind: string }>;
    }>("/api/company-gateway");

    expect(response.proxy).toMatchObject({ enabled: true, listenLan: false, restartRequired: false });
    expect(response.endpoints).toContainEqual({
      kind: "loopback",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });
    expect(JSON.stringify(response)).not.toContain(server.token);
  });
});
