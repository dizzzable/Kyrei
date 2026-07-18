import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): Promise<void> };
let connector: ReturnType<typeof fakeConnector>;

function login(status = "running") {
  return {
    id: "codex-flow-1",
    status,
    mode: "device",
    startedAt: 10,
    updatedAt: 20,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    email: "owner@example.test",
    refreshToken: "opaque-private-value",
  };
}

function fakeConnector(overrides: Record<string, unknown> = {}) {
  return {
    status: vi.fn(async () => ({
      installed: true,
      version: "0.130.0",
      authenticated: true,
      authMode: "chatgpt",
      planType: "plus",
      email: "owner@example.test",
      refreshToken: "opaque-private-value",
      activeLogin: null,
    })),
    startLogin: vi.fn(async ({ mode }: { mode?: string }) => ({ ...login(), mode: mode ?? "browser" })),
    loginStatus: vi.fn(() => ({ ...login("succeeded"), finishedAt: 30 })),
    cancelLogin: vi.fn(async () => ({ ...login("cancelled"), finishedAt: 30 })),
    logout: vi.fn(async () => ({ loggedOut: true, refreshToken: "opaque-private-value" })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function launch(overrides: Record<string, unknown> = {}) {
  connector = fakeConnector(overrides);
  server = await startGateway({ dataDir, preferredPort: 0, codexConnector: connector });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-codex-"));
  await launch();
});

afterEach(async () => {
  await server.close();
  expect(connector.close).toHaveBeenCalledOnce();
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
  const body = await response.json() as T & { code?: string };
  if (!response.ok) throw Object.assign(new Error(body.code ?? `${response.status}`), { status: response.status, body });
  return body;
}

describe("gateway ChatGPT / Codex connector boundary", () => {
  it("returns only renderer-safe account state", async () => {
    const status = await request<Record<string, unknown>>("/api/connectors/codex");

    expect(status).toEqual({
      installed: true,
      version: "0.130.0",
      authenticated: true,
      authMode: "chatgpt",
      planType: "plus",
    });
    expect(JSON.stringify(status)).not.toMatch(/owner|example|opaque-private|refresh/i);
  });

  it("accepts only the official login mode and keeps credentials out of login data", async () => {
    const started = await request<{ login: { id: string; mode: string; userCode: string } }>("/api/connectors/codex/login", {
      method: "POST",
      body: JSON.stringify({ mode: "device", apiKey: "private", endpoint: "https://evil.invalid" }),
    });

    expect(started.login).toMatchObject({ id: "codex-flow-1", mode: "device", userCode: "ABCD-EFGH" });
    expect(JSON.stringify(started)).not.toMatch(/owner|example|opaque-private|refresh/i);
    expect(connector.startLogin).toHaveBeenCalledWith({ mode: "device" });

    await expect(request<{ login: { status: string } }>("/api/connectors/codex/login/codex-flow-1"))
      .resolves.toMatchObject({ login: { status: "succeeded" } });
    await expect(request<{ login: { status: string } }>("/api/connectors/codex/login/codex-flow-1", { method: "DELETE" }))
      .resolves.toMatchObject({ login: { status: "cancelled" } });
  });

  it("activates the managed native provider instead of writing a fake API key profile", async () => {
    const config = await request<{ activeProviderId: string; activeModelId: string; providers: Array<Record<string, unknown>> }>("/api/connectors/codex/activate", {
      method: "POST",
      body: "{}",
    });

    expect(config.activeProviderId).toBe("openai-codex-chatgpt");
    expect(config.activeModelId).toBe("chatgpt-default");
    expect(config.providers).toContainEqual(expect.objectContaining({
      id: "openai-codex-chatgpt",
      protocol: "codex-app-server",
      requiresApiKey: false,
    }));
    await expect(request("/api/providers/openai-codex-chatgpt/accounts"))
      .rejects.toMatchObject({ status: 400, message: "codex_app_server_managed_connector_only" });
  });

  it("does not allow activation before the ChatGPT account is authenticated", async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-codex-unauth-"));
    await launch({ status: vi.fn(async () => ({ installed: true, authenticated: false, authMode: "none" })) });

    await expect(request("/api/connectors/codex/activate", { method: "POST", body: "{}" }))
      .rejects.toMatchObject({ status: 400, message: "codex_app_server_not_authenticated" });
  });

  it("does not send a ChatGPT-native profile through HTTP model discovery", async () => {
    await expect(request("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify({
        profile: { protocol: "codex-app-server", baseURL: "https://chatgpt.com/codex", requiresApiKey: false },
      }),
    })).rejects.toMatchObject({ status: 400, message: "codex_app_server_managed_connector_only" });
  });
});
