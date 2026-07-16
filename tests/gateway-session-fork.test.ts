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
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-fork-"));
  // Avoid SQLite session-mirror file locks on Windows afterEach cleanup.
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
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

async function seedParent(opts?: { withAssistantMid?: boolean }) {
  const store = new SessionStore({ runtimeDir: dataDir });
  await store.load();
  const parentId = "sess-fork-parent";
  store.upsertSession({
    id: parentId,
    title: "Parent chat",
    source: "chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const u1 = store.appendMessage(parentId, { role: "user", content: "first", text: "first" });
  let a1: { id: string } | null = null;
  if (opts?.withAssistantMid) {
    a1 = store.appendMessage(parentId, { role: "assistant", content: "reply", text: "reply" });
  } else {
    store.appendMessage(parentId, { role: "assistant", content: "reply", text: "reply" });
  }
  store.appendMessage(parentId, { role: "user", content: "second", text: "second" });
  await store.flush();
  await store.close(); // cancel debounced flush before gateway opens same dataDir
  return { parentId, u1Id: u1.id, a1Id: a1?.id };
}

async function bootGateway() {
  server = await startGateway({
    dataDir,
    preferredPort: 0,
  }) as GatewayServer;
}

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
  const body = await response.json() as T;
  return { status: response.status, body };
}

describe("POST /api/sessions/:id/fork", () => {
  it("forks full history with lineage and leaves parent messages intact", async () => {
    const { parentId } = await seedParent();
    await bootGateway();

    const parentBefore = await request<{ messages: Array<{ id: string }> }>(
      `/api/sessions/${encodeURIComponent(parentId)}/messages`,
    );
    expect(parentBefore.status).toBe(200);
    expect(parentBefore.body.messages.length).toBe(3);
    const parentIds = parentBefore.body.messages.map((m) => m.id);

    const forked = await request<{
      id: string;
      session: {
        id: string;
        parentSessionId?: string;
        rootSessionId?: string;
        lineageKind?: string;
      };
      messageCount?: number;
      code?: string;
      error?: string;
    }>(`/api/sessions/${encodeURIComponent(parentId)}/fork`, {
      method: "POST",
      body: "{}",
    });
    expect(forked.body, JSON.stringify(forked.body)).not.toMatchObject({ error: expect.anything() });
    expect(forked.status).toBe(200);
    expect(forked.body.id).toBeTruthy();
    expect(forked.body.id).not.toBe(parentId);
    expect(forked.body.session.parentSessionId).toBe(parentId);
    expect(forked.body.session.rootSessionId).toBe(parentId);
    expect(forked.body.session.lineageKind).toBe("branch");
    expect(forked.body.messageCount).toBe(3);

    const childMsgs = await request<{ messages: Array<{ id: string }> }>(
      `/api/sessions/${encodeURIComponent(forked.body.id)}/messages`,
    );
    expect(childMsgs.body.messages).toHaveLength(3);
    for (const id of childMsgs.body.messages.map((m) => m.id)) {
      expect(parentIds).not.toContain(id);
    }

    const parentAfter = await request<{ messages: Array<{ id: string }> }>(
      `/api/sessions/${encodeURIComponent(parentId)}/messages`,
    );
    expect(parentAfter.body.messages.map((m) => m.id)).toEqual(parentIds);

    const list = await request<{ sessions: Array<{ id: string; parentSessionId?: string }> }>("/api/sessions");
    expect(list.body.sessions.some((s) => s.id === forked.body.id)).toBe(true);
    expect(list.body.sessions.find((s) => s.id === forked.body.id)?.parentSessionId).toBe(parentId);
  });

  it("forks from a user message prefix", async () => {
    const { parentId, u1Id } = await seedParent();
    await bootGateway();

    const forked = await request<{
      id: string;
      session: { forkedFromMessageId?: string };
      messageCount?: number;
    }>(`/api/sessions/${encodeURIComponent(parentId)}/fork`, {
      method: "POST",
      body: JSON.stringify({ messageId: u1Id }),
    });
    expect(forked.status).toBe(200);
    expect(forked.body.messageCount).toBe(1);
    expect(forked.body.session.forkedFromMessageId).toBe(u1Id);

    const childMsgs = await request<{ messages: Array<{ content?: string; text?: string }> }>(
      `/api/sessions/${encodeURIComponent(forked.body.id)}/messages`,
    );
    expect(childMsgs.body.messages).toHaveLength(1);
    const text = childMsgs.body.messages[0]?.text || childMsgs.body.messages[0]?.content;
    expect(text).toBe("first");
  });

  it("returns 400 for non-user fork point and 404 for missing session", async () => {
    const store = new SessionStore({ runtimeDir: dataDir });
    await store.load();
    const parentId = "sess-fork-errors";
    store.upsertSession({
      id: parentId,
      title: "Err",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.appendMessage(parentId, { role: "user", content: "u", text: "u" });
    const a = store.appendMessage(parentId, { role: "assistant", content: "a", text: "a" });
    await store.flush();
    await store.close();
    await bootGateway();

    const bad = await request<{ code?: string }>(`/api/sessions/${encodeURIComponent(parentId)}/fork`, {
      method: "POST",
      body: JSON.stringify({ messageId: a.id }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("fork_message_not_user");

    const missing = await request<{ code?: string }>("/api/sessions/sess-does-not-exist/fork", {
      method: "POST",
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });
});
