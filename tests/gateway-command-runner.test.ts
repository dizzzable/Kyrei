import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startGateway } from "../core/gateway.js";

const roots: string[] = [];
const servers: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gateway command runner dependency", () => {
  it("passes the internal runner to the engine without exposing an HTTP command surface", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kyrei-command-runner-"));
    roots.push(dataDir);
    const runKyreiChat = vi.fn(async () => ({ text: "done", parts: [], status: "complete" }));
    const commandRunner = { run: vi.fn(async () => "unused") };
    const server = await startGateway({
      dataDir,
      preferredPort: 0,
      commandRunner,
      engineLoader: async () => ({ runKyreiChat, listModels: () => [] }),
    });
    servers.push(server);

    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        ...init,
        headers: { "X-Kyrei-Gateway-Token": server.token, ...(init?.headers ?? {}) },
      });
      const body = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(body.error ?? String(response.status));
      return body;
    };

    const config = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "test-runtime-credential" }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Run a safe command" }),
    });

    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    expect(runKyreiChat).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      commandRunner,
    }));
    expect(commandRunner.run).not.toHaveBeenCalled();
  });

  it("rejects a malformed internal runner before opening the gateway", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kyrei-command-runner-invalid-"));
    roots.push(dataDir);
    await expect(startGateway({ dataDir, preferredPort: 0, commandRunner: {} }))
      .rejects.toThrow("command-runner-invalid");
  });
});
