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
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: vi.fn(async () => includeAdapter
      ? { runKyreiChat: vi.fn(), createGBrainClient, runGBrainProcess }
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

    expect(status).toEqual({ state: "not_initialized", mode: "off", doctorStatus: "warnings" });
    expect(runGBrainProcess).not.toHaveBeenCalled();
    expect(createGBrainClient).toHaveBeenCalledWith(expect.objectContaining({
      mode: "read",
      command: "gbrain",
    }));
  });

  it("coalesces concurrent health probes and keeps the result stable briefly", async () => {
    createGBrainClient.mockClear();
    const statuses = await Promise.all([
      request<{ state: string }>("/api/memory/gbrain"),
      request<{ state: string }>("/api/memory/gbrain"),
      request<{ state: string }>("/api/memory/gbrain"),
    ]);
    expect(statuses.map((status) => status.state)).toEqual(["not_initialized", "not_initialized", "not_initialized"]);
    expect(createGBrainClient).toHaveBeenCalledTimes(1);
  });

  it("initializes only on the explicit endpoint and enables safe read access after a healthy check", async () => {
    const result = await request<{
      status: { state: string; mode: string };
      config: { engine: { memory: { gbrain: { mode: string; command: string } } } };
    }>("/api/memory/gbrain/initialize", { method: "POST" });

    expect(runGBrainProcess).toHaveBeenCalledWith(
      "gbrain",
      ["init", "--pglite", "--no-embedding"],
      expect.objectContaining({ timeoutMs: 180_000, maxOutputBytes: 200_000 }),
    );
    expect(result).toMatchObject({
      status: { state: "ready", mode: "read" },
      config: { engine: { memory: { gbrain: { mode: "read", command: "gbrain" } } } },
    });
    expect(await request<{ engine: { memory: { gbrain: { mode: string } } } }>("/api/config"))
      .toMatchObject({ engine: { memory: { gbrain: { mode: "read" } } } });
  });

  it("installs only after the explicit request, resolves Bun's global executable, and then initializes it", async () => {
    let installed = false;
    const globalBin = join(tmpdir(), "kyrei-gbrain-global-bin");
    const installedCommand = join(globalBin, process.platform === "win32" ? "gbrain.exe" : "gbrain");
    createGBrainClient.mockImplementation((options: { command?: string }) => {
      if (!installed && options.command === "gbrain") throw new Error("spawn gbrain ENOENT");
      return {
        doctor: vi.fn(async () => initialized
          ? { status: "warnings", checks: [{ message: "Local PGLite store is configured" }] }
          : { status: "warnings", checks: [{ message: "No database configured; run gbrain init" }] }),
      };
    });
    runGBrainProcess.mockImplementation(async (command: string, args: string[]) => {
      if (command === "bun" && args[0] === "install") {
        installed = true;
        return "installed";
      }
      if (command === "bun" && args.join(" ") === "pm bin -g") return globalBin;
      if (command === installedCommand && args[0] === "init") {
        initialized = true;
        return "initialized";
      }
      return "ok";
    });

    expect(await request<{ state: string; reason: string }>("/api/memory/gbrain"))
      .toEqual({ state: "unavailable", mode: "off", reason: "command_unavailable", doctorStatus: "unknown" });

    const result = await request<{
      status: { state: string; mode: string };
      config: { engine: { memory: { gbrain: { mode: string; command: string } } } };
    }>("/api/memory/gbrain/install", { method: "POST" });

    expect(runGBrainProcess).toHaveBeenCalledWith(
      "bun",
      ["--version"],
      expect.objectContaining({ timeoutMs: 180_000, maxOutputBytes: 1_000_000 }),
    );
    expect(runGBrainProcess).toHaveBeenCalledWith("bun", ["install", "-g", "github:garrytan/gbrain"], expect.any(Object));
    expect(runGBrainProcess).toHaveBeenCalledWith("bun", ["pm", "bin", "-g"], expect.any(Object));
    expect(runGBrainProcess).toHaveBeenCalledWith(
      installedCommand,
      ["init", "--pglite", "--no-embedding"],
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
    expect(result).toMatchObject({
      status: { state: "ready", mode: "read" },
      config: { engine: { memory: { gbrain: { mode: "read", command: installedCommand } } } },
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
        ? { runKyreiChat: vi.fn(), createGBrainClient, runGBrainProcess }
        : { runKyreiChat: vi.fn() })),
    });
    const status = await request<{ state: string; reason: string; doctorStatus: string }>("/api/memory/gbrain");

    expect(status).toEqual({ state: "unavailable", mode: "off", reason: "adapter_unavailable", doctorStatus: "unknown" });
    expect(runGBrainProcess).not.toHaveBeenCalled();
  });

  it("does not mistake a malformed health response for an initialized local store", async () => {
    createGBrainClient.mockReturnValue({ doctor: vi.fn(async () => []) });

    expect(await request<{ state: string; doctorStatus: string }>("/api/memory/gbrain"))
      .toEqual({ state: "error", mode: "off", doctorStatus: "unknown" });
  });
});
