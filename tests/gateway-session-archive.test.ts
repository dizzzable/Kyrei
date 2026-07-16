import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { SessionStore } from "../core/session-store.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };

let dataDir = "";
let server: GatewayServer | null = null;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-arch-"));
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
    workspace: dataDir,
    engine: {
      memory: {
        // Keep mirror off so Windows cleanup is not blocked by SQLite.
        sessionMirror: { enabled: false, readSearch: false, enginePrimary: false },
        curator: {
          enabled: true,
          autoOnArchive: true,
          useLlm: false, // heuristic only — still exercises schedule path
        },
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
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
});

async function seedSession() {
  const store = new SessionStore({ runtimeDir: dataDir });
  await store.load();
  const id = "sess-arch-1";
  store.upsertSession({
    id,
    title: "Archive me",
    source: "chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.appendMessage(id, { role: "user", content: "remember that we use vitest", text: "remember that we use vitest" });
  store.appendMessage(id, { role: "assistant", content: "ok", text: "ok" });
  await store.flush();
  await store.close();
  return id;
}

async function bootGateway() {
  server = await startGateway({
    dataDir,
    preferredPort: 0,
  }) as GatewayServer;
}

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; ms: number }> {
  if (!server) throw new Error("test gateway is not running");
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T;
  return { status: response.status, body, ms: Date.now() - started };
}

describe("PATCH /api/sessions/:id soft-archive", () => {
  it("returns immediately with curatorScheduled and does not embed curator result", async () => {
    const id = await seedSession();
    await bootGateway();

    const { status, body, ms } = await request<{
      ok: boolean;
      session: { id: string; archived?: boolean };
      curatorScheduled?: boolean;
      curator?: unknown;
    }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.session.archived).toBe(true);
    expect(body.curatorScheduled).toBe(true);
    expect(body.curator).toBeUndefined();
    // Archive must not wait on LLM/curator; heuristic background is fine but HTTP stays fast.
    expect(ms).toBeLessThan(5_000);

    const list = await request<{ sessions: Array<{ id: string }> }>("/api/sessions");
    expect(list.status).toBe(200);
    expect(list.body.sessions.some((s) => s.id === id)).toBe(false);

    const archived = await request<{ sessions: Array<{ id: string; archived?: boolean }> }>(
      "/api/sessions?archived=only",
    );
    expect(archived.status).toBe(200);
    expect(archived.body.sessions.some((s) => s.id === id)).toBe(true);
  });

  it("restore clears archived without scheduling curator", async () => {
    const id = await seedSession();
    await bootGateway();

    await request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });

    const { status, body } = await request<{
      ok: boolean;
      session: { archived?: boolean };
      curatorScheduled?: boolean;
    }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: false }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.session.archived).toBeFalsy();
    expect(body.curatorScheduled).toBeUndefined();
  });
});
