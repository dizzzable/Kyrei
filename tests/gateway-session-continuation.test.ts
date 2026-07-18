import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { SessionStore } from "../core/session-store.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };

let dataDir = "";
let workspace = "";
let server: GatewayServer | null = null;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-continuation-"));
  workspace = await mkdtemp(join(tmpdir(), "kyrei-workspace-continuation-"));
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
    workspace,
    engine: {
      memory: {
        sessionMirror: { enabled: false, readSearch: false, enginePrimary: false },
      },
    },
  }, null, 2)}\n`, "utf8");
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    /* ignore */
  }
  server = null;
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  if (!server) throw new Error("test gateway is not running");
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() as T };
}

describe("POST /api/sessions/:id/continue", () => {
  it("creates a blank child and persists a bounded continuation packet", async () => {
    const store = new SessionStore({ runtimeDir: dataDir });
    await store.load();
    const parentId = "sess-continuation-parent";
    store.upsertSession({
      id: parentId,
      title: "Long task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerId: "provider",
      modelId: "model",
    });
    store.appendMessage(parentId, { role: "user", text: "Continue the task" });
    store.appendMessage(parentId, {
      role: "assistant",
      text: "Storage implemented",
      parts: [{
        type: "tool",
        name: "write_file",
        args: { path: "src/state.ts" },
        result: "written",
        running: false,
      }],
    });
    await store.flush();
    await store.close();

    server = await startGateway({ dataDir, preferredPort: 0 }) as GatewayServer;
    const result = await request<{
      id: string;
      session: { lineageKind?: string; parentSessionId?: string; continuationSourceSessionId?: string };
      packet?: { sourceSessionId?: string; verifiedMutationCount?: number };
    }>(`/api/sessions/${parentId}/continue`, { method: "POST" });

    expect(result.status).toBe(200);
    expect(result.body.session).toMatchObject({
      lineageKind: "continuation",
      parentSessionId: parentId,
      continuationSourceSessionId: parentId,
    });
    expect(result.body.packet).toMatchObject({ sourceSessionId: parentId, verifiedMutationCount: 1 });

    const childMessages = await request<{ messages: unknown[] }>(`/api/sessions/${result.body.id}/messages`);
    expect(childMessages.body.messages).toEqual([]);
    const packet = JSON.parse(await readFile(
      join(workspace, ".kyrei", "continuations", `${result.body.id}.json`),
      "utf8",
    )) as { verifiedMutations?: Array<{ path: string }> };
    expect(packet.verifiedMutations).toEqual([{ tool: "write_file", path: "src/state.ts" }]);
  });
});
