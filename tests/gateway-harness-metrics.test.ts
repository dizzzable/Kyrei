import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };
type StatusResponse = { harness?: Record<string, unknown> };

let dataDir = "";
let workspace = "";
let server: GatewayServer | null = null;
/** Result the stub engine returns for the next turn. */
let nextResult: Record<string, unknown> = {};
let turns = 0;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!server) throw new Error("test gateway is not running");
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  return await response.json() as T;
}

beforeEach(async () => {
  turns = 0;
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-harness-"));
  workspace = await mkdtemp(join(tmpdir(), "kyrei-workspace-harness-"));
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({ workspace }, null, 2)}\n`, "utf8");
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => ({
      listModels: () => [],
      runKyreiChat: async () => {
        turns += 1;
        return { text: "ok", parts: [], status: "complete", ...nextResult };
      },
    }),
  });
  const config = await request<{ activeProviderId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "harness-metrics-test-key" }),
  });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    /* ignore close races */
  }
  server = null;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function prompt(session: string, text: string, expected: number) {
  await request("/api/prompt", { method: "POST", body: JSON.stringify({ session, text }) });
  await vi.waitFor(() => expect(turns).toBe(expected));
}

describe("last harness snapshot", () => {
  it("is cleared by a turn that reports none, not left stale", async () => {
    // Regression: the assignment was guarded on `result.harness` existing, so
    // a turn without one (every Codex turn, and any engine turn that skipped
    // the harness) left the PREVIOUS turn's numbers in place — and /api/status
    // presents them as the latest turn's.
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });

    nextResult = { harness: { toolCalls: 7 } };
    await prompt(session.id, "first", 1);
    await vi.waitFor(async () => {
      expect((await request<StatusResponse>("/api/status")).harness).toBeTruthy();
    });

    nextResult = {};
    await prompt(session.id, "second", 2);
    await vi.waitFor(async () => {
      expect((await request<StatusResponse>("/api/status")).harness).toBeUndefined();
    });
  });

  it("still reports the snapshot of a turn that has one", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    nextResult = { harness: { toolCalls: 3 } };
    await prompt(session.id, "only turn", 1);
    await vi.waitFor(async () => {
      expect((await request<StatusResponse>("/api/status")).harness).toBeTruthy();
    });
  });
});
