import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

// Boots a real gateway and does real file I/O; under the suite's parallel
// workers that regularly exceeds the 15s global budget on Windows.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type GatewayServer = { port: number; token: string; close(): Promise<void> };
type RunTurnOpts = {
  threadId?: string;
  prompt?: string;
  resumeSeed?: string;
  onThread?: (id: string) => Promise<void> | void;
  onThreadReset?: (info: { threadId?: string; reason: string }) => Promise<void> | void;
};

let dataDir = "";
let server: GatewayServer;
let turns: RunTurnOpts[] = [];

/**
 * Stands in for the Codex App Server. Turn 1 opens a thread; turn 2 reports the
 * thread as unusable — exactly what the real connector does when its
 * `thread/resume` request fails — and then opens a replacement.
 */
function connectorWithLostThread() {
  let turn = 0;
  return {
    status: vi.fn(async () => ({
      installed: true,
      version: "0.130.0",
      authenticated: true,
      authMode: "chatgpt",
      planType: "plus",
      email: "owner@example.test",
      activeLogin: null,
    })),
    startLogin: vi.fn(async () => ({ id: "f", status: "running", mode: "browser", startedAt: 1, updatedAt: 1 })),
    loginStatus: vi.fn(() => ({ id: "f", status: "succeeded", mode: "browser", startedAt: 1, updatedAt: 1 })),
    cancelLogin: vi.fn(async () => ({ id: "f", status: "cancelled", mode: "browser", startedAt: 1, updatedAt: 1 })),
    logout: vi.fn(async () => ({ loggedOut: true })),
    runTurn: vi.fn(async (opts: RunTurnOpts) => {
      turns.push(opts);
      turn += 1;
      if (turn === 1) {
        await opts.onThread?.("thread-alpha");
        return { text: "first answer", parts: [], status: "complete", route: { providerId: "openai-codex-chatgpt" } };
      }
      await opts.onThreadReset?.({ threadId: opts.threadId, reason: "thread not found" });
      await opts.onThread?.("thread-beta");
      return { text: "second answer", parts: [], status: "complete", route: { providerId: "openai-codex-chatgpt" } };
    }),
    close: vi.fn(async () => undefined),
  };
}

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
  if (!response.ok) throw Object.assign(new Error(body.code ?? `${response.status}`), { status: response.status });
  return body;
}

async function storedMessages(id: string) {
  const state = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8")) as {
    messages?: Record<string, Array<{ role?: string; modelMessages?: unknown }>>;
  };
  return state.messages?.[id] ?? [];
}

async function storedSession(id: string) {
  const state = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8")) as {
    sessions?: Record<string, Record<string, unknown>> | Array<Record<string, unknown>>;
  };
  const sessions = state.sessions;
  const rows = Array.isArray(sessions) ? sessions : Object.values(sessions ?? {});
  return rows.find((row) => row.id === id);
}

beforeEach(async () => {
  turns = [];
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-codex-reset-"));
  server = await startGateway({ dataDir, preferredPort: 0, codexConnector: connectorWithLostThread() });
  await request("/api/connectors/codex/activate", { method: "POST", body: "{}" });
  await request("/api/config", { method: "PUT", body: JSON.stringify({ workspace: dataDir }) });
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("Codex thread loss", () => {
  it("re-seeds a replacement thread with the conversation Codex dropped", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });

    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "remember the number 41" }),
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // A brand-new session has nothing to replay.
    expect(turns[0]!.threadId).toBeFalsy();

    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "what number did I say?" }),
    });
    await vi.waitFor(() => expect(turns).toHaveLength(2));

    // Turn 2 resumes the thread opened by turn 1 …
    expect(turns[1]!.threadId).toBe("thread-alpha");
    // … and carries the fallback transcript, which this path used to discard
    // entirely. Without it a dropped thread is silent, total amnesia: Codex
    // owns the history, so nothing else holds a copy.
    const seed = turns[1]!.resumeSeed ?? "";
    expect(seed).toContain("remember the number 41");
    expect(seed).toContain("first answer");
    expect(seed).toMatch(/previous thread was lost/i);
  });

  it("forgets the dead thread id so the next turn cannot retry it", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "one" }) });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(async () => expect((await storedSession(session.id))?.codexThreadId).toBe("thread-alpha"));

    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "two" }) });
    await vi.waitFor(() => expect(turns).toHaveLength(2));

    // The replacement thread is what persists — not the id that failed.
    await vi.waitFor(async () => expect((await storedSession(session.id))?.codexThreadId).toBe("thread-beta"));

    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "three" }) });
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    expect(turns[2]!.threadId).toBe("thread-beta");
  });
});

describe("Codex result contract", () => {
  it("persists structured model history so a later provider replays a real record", async () => {
    // The connector returns its own shape, not RunKyreiChatResult. Without a
    // normalizer the turn persisted no `modelMessages` at all and the next
    // turn depended on convoFor's plain-text fallback.
    const session = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "hello" }) });
    await vi.waitFor(() => expect(turns).toHaveLength(1));

    await vi.waitFor(async () => {
      const stored = await storedMessages(session.id);
      const assistant = stored.filter((m) => m.role === "assistant").at(-1);
      expect(assistant?.modelMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      ]);
    });
  });
});
