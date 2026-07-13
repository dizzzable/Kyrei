import { describe, expect, it, vi } from "vitest";
import { createKiroConnectorApi, publicKiroLogin } from "../core/kiro-connector-api.js";

function fakeConnector(overrides: Record<string, unknown> = {}) {
  return {
    detect: vi.fn(async () => ({ installed: true, version: "2.3.0", privatePath: "C:/private" })),
    whoami: vi.fn(async () => ({
      authenticated: true,
      method: "github",
      accountType: "free",
      email: "owner@example.test",
      accessToken: "sk-private-value",
    })),
    capabilities: vi.fn(() => ({ accountIsolation: "global", maxAccounts: 1, supportsAccountPool: false, token: "private" })),
    discoverModels: vi.fn(async () => ["auto", "claude-sonnet-4.5", "auto"]),
    startLogin: vi.fn(() => ({
      id: "flow-1",
      status: "running",
      mode: "browser",
      method: "github",
      startedAt: 1,
      updatedAt: 2,
        progress: "Open the system browser for owner@example.test#access_token=opaque-private-value",
      email: "owner@example.test",
      token: "private",
    })),
    getLoginStatus: vi.fn(() => ({
      id: "flow-1",
      status: "succeeded",
      mode: "browser",
      method: "github",
      startedAt: 1,
      updatedAt: 3,
      finishedAt: 3,
      progress: "Done",
    })),
    cancelLogin: vi.fn(() => ({
      id: "flow-1",
      status: "cancelled",
      mode: "browser",
      method: "github",
      startedAt: 1,
      updatedAt: 3,
      finishedAt: 3,
      progress: "",
    })),
    logout: vi.fn(async () => ({ loggedOut: true, output: "private" })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Kiro connector renderer-safe API", () => {
  it("allowlists status fields and never serializes identity or credentials", async () => {
    const api = createKiroConnectorApi(fakeConnector());
    const status = await api.status();

    expect(status).toEqual({
      installed: true,
      version: "2.3.0",
      authenticated: true,
      method: "github",
      accountType: "free",
      capabilities: { accountIsolation: "global", maxAccounts: 1, supportsAccountPool: false },
    });
    expect(JSON.stringify(status)).not.toMatch(/owner|example|opaque-private|privatePath|C:\//i);
  });

  it("returns a safe active login and strips arbitrary connector fields", async () => {
    const connector = fakeConnector({
      activeLogin: vi.fn(() => ({
        id: "active_1",
        status: "running",
        mode: "device",
        method: "free",
        startedAt: 10,
        updatedAt: 20,
        progress: "Enter ABCD-EFGH",
        email: "owner@example.test",
      })),
    });
    const status = await createKiroConnectorApi(connector).status();

    expect(status.activeLogin).toEqual({
      id: "active_1",
      status: "running",
      mode: "device",
      method: "free",
      startedAt: 10,
      updatedAt: 20,
      progress: "Enter ABCD-EFGH",
    });
    expect(JSON.stringify(status)).not.toMatch(/owner|example/i);
  });

  it("normalizes model output and forwards only supported login options", async () => {
    const connector = fakeConnector();
    const api = createKiroConnectorApi(connector);

    await expect(api.models()).resolves.toEqual({
      models: [
        { id: "auto", name: "auto" },
        { id: "claude-sonnet-4.5", name: "claude-sonnet-4.5" },
      ],
      count: 2,
    });
    const started = api.startLogin({
      mode: "device",
      method: "identity-center",
      identityProvider: "https://team.awsapps.com/start",
      region: "us-east-1",
      executable: "calc.exe",
      token: "private",
    });
    expect(started).toMatchObject({ login: { id: "flow-1" } });
    expect(JSON.stringify(started)).not.toMatch(/owner|example|opaque-private/i);
    expect(connector.startLogin).toHaveBeenCalledWith({
      mode: "device",
      method: "identity-center",
      identityProvider: "https://team.awsapps.com/start",
      region: "us-east-1",
    });
  });

  it("keeps login, cancel, logout and shutdown results bounded", async () => {
    const connector = fakeConnector();
    const api = createKiroConnectorApi(connector);

    expect(api.loginStatus("flow-1")).toMatchObject({ login: { status: "succeeded" } });
    expect(api.cancelLogin("flow-1")).toMatchObject({ login: { status: "cancelled" } });
    await expect(api.logout()).resolves.toEqual({ loggedOut: true });
    await api.close();
    expect(connector.close).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed login snapshots", () => {
    expect(publicKiroLogin({ id: "../unsafe", status: "running", startedAt: 1, updatedAt: 1 })).toBeNull();
    expect(publicKiroLogin({ id: "safe", status: "running", startedAt: -1, updatedAt: 1 })).toBeNull();
  });
});
