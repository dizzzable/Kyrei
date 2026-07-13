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
    id: "flow-1",
    status,
    mode: "device",
    method: "github",
    startedAt: 10,
    updatedAt: 20,
    progress: "owner@example.test#access_token=opaque-private-value user_code=ABCD-EFGH",
    email: "owner@example.test",
    accessToken: "opaque-private-value",
  };
}

function fakeConnector(overrides: Record<string, unknown> = {}) {
  return {
    detect: vi.fn(async () => ({ installed: true, version: "2.3.0", executable: "C:/private/kiro-cli.exe" })),
    whoami: vi.fn(async () => ({
      authenticated: true,
      method: "github",
      accountType: "free",
      email: "owner@example.test",
      accessToken: "opaque-private-value",
    })),
    capabilities: vi.fn(() => ({
      accountIsolation: "global",
      maxAccounts: 1,
      supportsAccountPool: false,
      secret: "private",
    })),
    activeLogin: vi.fn(() => null),
    discoverModels: vi.fn(async () => ["auto", "claude-sonnet-4.5", "auto"]),
    startLogin: vi.fn(() => login()),
    getLoginStatus: vi.fn(() => ({ ...login("succeeded"), finishedAt: 30 })),
    cancelLogin: vi.fn(() => ({ ...login("cancelled"), finishedAt: 30 })),
    logout: vi.fn(async () => ({ loggedOut: true, output: "owner@example.test" })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function launch(overrides: Record<string, unknown> = {}) {
  connector = fakeConnector(overrides);
  server = await startGateway({ dataDir, preferredPort: 0, kiroConnector: connector });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-kiro-"));
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

describe("gateway Kiro CLI connector boundary", () => {
  it("returns only allowlisted status fields", async () => {
    const status = await request<Record<string, unknown>>("/api/connectors/kiro");

    expect(status).toEqual({
      installed: true,
      version: "2.3.0",
      authenticated: true,
      method: "github",
      accountType: "free",
      capabilities: { accountIsolation: "global", maxAccounts: 1, supportsAccountPool: false },
    });
    expect(JSON.stringify(status)).not.toMatch(/owner|example|opaque-private|executable|secret/i);
  });

  it("starts, polls and cancels a sanitized login while forwarding only documented options", async () => {
    const started = await request<{ login: { id: string; progress: string } }>("/api/connectors/kiro/login", {
      method: "POST",
      body: JSON.stringify({
        mode: "device",
        method: "identity-center",
        identityProvider: "https://team.awsapps.com/start",
        region: "us-east-1",
        executable: "calc.exe",
        token: "private",
      }),
    });
    expect(started.login.id).toBe("flow-1");
    expect(started.login.progress).toContain("user_code=ABCD-EFGH");
    expect(JSON.stringify(started)).not.toMatch(/owner|example|opaque-private/i);
    expect(connector.startLogin).toHaveBeenCalledWith({
      mode: "device",
      method: "identity-center",
      identityProvider: "https://team.awsapps.com/start",
      region: "us-east-1",
    });

    await expect(request<{ login: { status: string } }>("/api/connectors/kiro/login/flow-1"))
      .resolves.toMatchObject({ login: { status: "succeeded" } });
    await expect(request<{ login: { status: string } }>("/api/connectors/kiro/login/flow-1", { method: "DELETE" }))
      .resolves.toMatchObject({ login: { status: "cancelled" } });
  });

  it("discovers bounded models and logs out without exposing command output", async () => {
    await expect(request("/api/connectors/kiro/models")).resolves.toEqual({
      models: [
        { id: "auto", name: "auto" },
        { id: "claude-sonnet-4.5", name: "claude-sonnet-4.5" },
      ],
      count: 2,
    });
    await expect(request("/api/connectors/kiro/logout", { method: "POST", body: "{}" }))
      .resolves.toEqual({ loggedOut: true });
  });

  it("requires the per-launch capability before touching the connector", async () => {
    const before = connector.detect.mock.calls.length;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/connectors/kiro`);
    expect(response.status).toBe(401);
    expect(connector.detect).toHaveBeenCalledTimes(before);
  });

  it("maps concurrent auth mutation errors to conflict", async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-kiro-conflict-"));
    const error = Object.assign(new Error("private detail"), { code: "kiro_cli_auth_busy" });
    await launch({ startLogin: vi.fn(() => { throw error; }) });

    await expect(request("/api/connectors/kiro/login", { method: "POST", body: "{}" }))
      .rejects.toMatchObject({ status: 409 });
  });
});
