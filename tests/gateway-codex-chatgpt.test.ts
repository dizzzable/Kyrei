import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): Promise<void> };
let connector: ReturnType<typeof fakeConnector>;
let managedConnector: ReturnType<typeof fakeConnector>;
let backupManagedConnector: ReturnType<typeof fakeConnector>;

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
    runTurn: vi.fn(async () => ({ text: "native complete", parts: [], status: "complete", route: { providerId: "openai-codex-chatgpt" } })),
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
      hasKey: true,
    }));
    await expect(request("/api/providers/openai-codex-chatgpt/accounts"))
      .rejects.toMatchObject({ status: 400, message: "codex_app_server_managed_connector_only" });

    await request("/api/config", { method: "PUT", body: JSON.stringify({ workspace: dataDir }) });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Use my personal ChatGPT login" }),
    });
    await vi.waitFor(() => expect(connector.runTurn).toHaveBeenCalledTimes(1));
    expect(connector.runTurn).toHaveBeenCalledWith(expect.not.objectContaining({ accountId: expect.anything() }));
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

  it("manages multiple official ChatGPT profiles without persisting OAuth material", async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-codex-pool-"));
    connector = fakeConnector();
    managedConnector = fakeConnector();
    backupManagedConnector = fakeConnector();
    const profileFactory = vi.fn(({ accountId }: { accountId: string }) => (
      accountId === "backup-plus" ? backupManagedConnector : managedConnector
    ));
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      codexConnector: connector,
      codexPoolConnectorFactory: profileFactory,
    });

    const created = await request<{ accounts: Array<{ id: string; status: string }> }>("/api/connectors/codex/pool/accounts", {
      method: "POST",
      body: JSON.stringify({ account: { id: "owner-plus", name: "Owner Plus", weight: 2 } }),
    });
    expect(created.accounts).toContainEqual(expect.objectContaining({ id: "owner-plus", status: "auth-required" }));
    expect(JSON.stringify(created)).not.toMatch(/refresh|opaque|token|owner@example/i);

    const refreshed = await request<{ status: { authenticated: boolean }; pool: { accounts: Array<{ status: string; planType?: string }> } }>("/api/connectors/codex/pool/accounts/owner-plus");
    expect(refreshed.status.authenticated).toBe(true);
    expect(refreshed.pool.accounts).toContainEqual(expect.objectContaining({ status: "ready", planType: "plus" }));
    expect(profileFactory).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "owner-plus",
      codexHome: expect.stringContaining("codex-chatgpt"),
    }));

    await request("/api/connectors/codex/pool/accounts", {
      method: "POST",
      body: JSON.stringify({ account: { id: "backup-plus", name: "Backup Plus", priority: 10 } }),
    });
    await request("/api/connectors/codex/pool/accounts/backup-plus");

    await request("/api/connectors/codex/pool", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, strategy: "round-robin", sessionAffinity: true }),
    });
    const active = await request<{ activeProviderId: string; activeModelId: string }>("/api/connectors/codex/pool/activate", {
      method: "POST",
      body: "{}",
    });
    expect(active).toMatchObject({ activeProviderId: "openai-codex-chatgpt", activeModelId: "chatgpt-default" });

    managedConnector.runTurn.mockRejectedValueOnce(Object.assign(new Error("temporary upstream outage"), { code: "codex_app_server_unavailable" }));
    backupManagedConnector.runTurn.mockImplementationOnce(async (input: { accountId?: string; onThread?: (threadId: string) => Promise<void> }) => {
      await input.onThread?.("thr-owner-plus");
      return {
        text: "native complete",
        parts: [],
        status: "complete",
        route: { providerId: "openai-codex-chatgpt", accountId: input.accountId, modelId: "chatgpt-default" },
      };
    });
    await request("/api/config", { method: "PUT", body: JSON.stringify({ workspace: dataDir }) });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "Use the managed account" }) });
    await vi.waitFor(() => expect(backupManagedConnector.runTurn).toHaveBeenCalledTimes(1));
    expect(managedConnector.runTurn).toHaveBeenCalledWith(expect.objectContaining({ accountId: "owner-plus" }));
    expect(backupManagedConnector.runTurn).toHaveBeenCalledWith(expect.objectContaining({ accountId: "backup-plus" }));
    const sessions = await request<{ sessions: Array<{ id: string; providerAccountId?: string; codexThreadIds?: Record<string, string> }> }>("/api/sessions");
    expect(sessions.sessions.find((row) => row.id === session.id)).toMatchObject({
      providerAccountId: "backup-plus",
      codexThreadIds: { "backup-plus": "thr-owner-plus" },
    });

    // An explicit subscription/entitlement stop is not a reason to burn
    // another personal account.  Only a transient transport failure may
    // advance through the local pool.
    await request("/api/connectors/codex/pool/accounts/owner-plus");
    managedConnector.runTurn.mockRejectedValueOnce(Object.assign(new Error("subscription quota exhausted"), {
      code: "quota_exhausted",
    }));
    const blocked = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: blocked.id, text: "Do not bypass the subscription limit" }),
    });
    await vi.waitFor(() => expect(managedConnector.runTurn).toHaveBeenCalledTimes(2));
    expect(backupManagedConnector.runTurn).toHaveBeenCalledTimes(1);
  });
});
