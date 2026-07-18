import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): Promise<void> };
let initialized = false;
let includeAdapter = true;
let createGBrainClient: ReturnType<typeof vi.fn>;
let runGBrainProcess: ReturnType<typeof vi.fn>;
let inspectBuiltinGBrainStore: ReturnType<typeof vi.fn>;
let initializeBuiltinGBrainStore: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-gbrain-"));
  initialized = false;
  includeAdapter = true;
  createGBrainClient = vi.fn(() => ({
    doctor: vi.fn(async () => initialized
      ? { status: "warnings", checks: [{ message: "Local PGLite store is configured" }] }
      : { status: "warnings", checks: [{ message: "No database configured; run gbrain init" }] }),
  }));
  runGBrainProcess = vi.fn(async () => {
    initialized = true;
    return "initialized";
  });
  inspectBuiltinGBrainStore = vi.fn(() => ({ initialized }));
  initializeBuiltinGBrainStore = vi.fn(async () => { initialized = true; });
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: vi.fn(async () => includeAdapter
      ? { runKyreiChat: vi.fn(), createGBrainClient, runGBrainProcess, inspectBuiltinGBrainStore, initializeBuiltinGBrainStore }
      : { runKyreiChat: vi.fn() }),
  });
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function response(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await response(path, init);
  const body = await result.json() as T & { error?: string };
  if (!result.ok) throw new Error(body.error ?? `${result.status}`);
  return body;
}

describe("gateway GBrain onboarding", () => {
  it("reports a missing local store without running setup automatically", async () => {
    const status = await request<{
      state: string;
      mode: string;
      doctorStatus: string;
    }>("/api/memory/gbrain");

    expect(status).toEqual({ state: "not_initialized", provider: "builtin", mode: "off", doctorStatus: "warnings" });
    expect(runGBrainProcess).not.toHaveBeenCalled();
    expect(createGBrainClient).not.toHaveBeenCalled();
    expect(inspectBuiltinGBrainStore).toHaveBeenCalledWith(join(dataDir, "memory"));
  });

  it("coalesces concurrent health probes and keeps the result stable briefly", async () => {
    inspectBuiltinGBrainStore.mockClear();
    const statuses = await Promise.all([
      request<{ state: string }>("/api/memory/gbrain"),
      request<{ state: string }>("/api/memory/gbrain"),
      request<{ state: string }>("/api/memory/gbrain"),
    ]);
    expect(statuses.map((status) => status.state)).toEqual(["not_initialized", "not_initialized", "not_initialized"]);
    expect(inspectBuiltinGBrainStore).toHaveBeenCalledTimes(1);
  });

  it("initializes only on the explicit endpoint and enables safe read access after a healthy check", async () => {
    const result = await request<{
      status: { state: string; provider: string; mode: string };
      config: { engine: { memory: { gbrain: { provider: string; mode: string } } } };
    }>("/api/memory/gbrain/initialize", { method: "POST" });

    expect(initializeBuiltinGBrainStore).toHaveBeenCalledWith(join(dataDir, "memory"));
    expect(runGBrainProcess).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: { state: "ready", provider: "builtin", mode: "read" },
      config: { engine: { memory: { gbrain: { provider: "builtin", mode: "read" } } } },
    });
    expect(await request<{ engine: { memory: { gbrain: { mode: string } } } }>("/api/config"))
      .toMatchObject({ engine: { memory: { gbrain: { mode: "read" } } } });
  });

  it("keeps the legacy install endpoint local and never runs Bun or GitHub setup", async () => {
    const result = await request<{
      status: { state: string; provider: string; mode: string };
      config: { engine: { memory: { gbrain: { provider: string; mode: string } } } };
    }>("/api/memory/gbrain/install", { method: "POST" });
    expect(initializeBuiltinGBrainStore).toHaveBeenCalledTimes(1);
    expect(runGBrainProcess).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: { state: "ready", provider: "builtin", mode: "read" },
      config: { engine: { memory: { gbrain: { provider: "builtin", mode: "read" } } } },
    });
  });

  it("returns a structured unavailable state when this build has no GBrain adapter", async () => {
    // Engine module is cached after OOB bootstrap — restart without the GBrain adapter.
    await server.close();
    includeAdapter = false;
    runGBrainProcess.mockClear();
    createGBrainClient.mockClear();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: vi.fn(async () => (includeAdapter
        ? { runKyreiChat: vi.fn(), createGBrainClient, runGBrainProcess, inspectBuiltinGBrainStore, initializeBuiltinGBrainStore }
        : { runKyreiChat: vi.fn() })),
    });
    const status = await request<{ state: string; reason: string; doctorStatus: string }>("/api/memory/gbrain");

    expect(status).toEqual({ state: "unavailable", provider: "builtin", mode: "off", reason: "adapter_unavailable", doctorStatus: "unknown" });
    expect(runGBrainProcess).not.toHaveBeenCalled();
  });

  it("does not mark the store ready until the built-in probe confirms it", async () => {
    inspectBuiltinGBrainStore.mockReturnValue({ initialized: false });

    expect(await request<{ state: string; doctorStatus: string }>("/api/memory/gbrain"))
      .toEqual({ state: "not_initialized", provider: "builtin", mode: "off", doctorStatus: "warnings" });
  });
});
