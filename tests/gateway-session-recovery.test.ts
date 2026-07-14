import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { SkillsStore } from "../core/skills-store.js";
import { SessionStore } from "../core/session-store.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> };
type PublicMessage = {
  id: string;
  role: string;
  content: string;
  pending?: boolean;
  turnStatus?: string;
  parts?: Array<Record<string, unknown>>;
};

let dataDir = "";
let server: GatewayServer | null = null;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-session-recovery-"));
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(dataDir, { recursive: true, force: true });
});

async function start(options: Record<string, unknown>) {
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    activeTurnSettleTimeoutMs: 25,
    ...options,
  }) as GatewayServer;
  const config = await request<{ activeProviderId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "session-recovery-test-key" }),
  });
}

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
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}

async function messages(sessionId: string) {
  return request<{ messages: PublicMessage[] }>(`/api/sessions/${sessionId}/messages`)
    .then((result) => result.messages);
}

async function openEventStream(sessionId: string) {
  if (!server) throw new Error("test gateway is not running");
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const outgoing = nodeRequest({
    hostname: "127.0.0.1",
    port: server.port,
    path: `/api/events?session=${encodeURIComponent(sessionId)}`,
    method: "GET",
    headers: { "X-Kyrei-Gateway-Token": server.token },
  });
  const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
  let buffer = "";
  incoming.setEncoding("utf8");
  incoming.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) events.push(JSON.parse(data));
      boundary = buffer.indexOf("\n\n");
    }
  });
  return {
    events,
    close() {
      incoming.destroy();
      outgoing.destroy();
    },
  };
}

async function createSession() {
  return request<{ id: string }>("/api/sessions", { method: "POST" });
}

async function sendPrompt(sessionId: string, text = "Keep this turn") {
  return request<{ status: string }>("/api/prompt", {
    method: "POST",
    body: JSON.stringify({ session: sessionId, text }),
  });
}

function startPartialJsonRequest(path: string, method: "POST" | "PATCH", payload: string) {
  if (!server) throw new Error("test gateway is not running");
  const data = Buffer.from(payload, "utf8");
  const splitAt = Math.max(1, data.byteLength - 2);
  const outgoing = nodeRequest({
    hostname: "127.0.0.1",
    port: server.port,
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": data.byteLength,
      "X-Kyrei-Gateway-Token": server.token,
    },
  });
  // A shutdown may close the response before the test sends the remainder.
  outgoing.on("error", () => undefined);
  outgoing.write(data.subarray(0, splitAt));
  return {
    finish() {
      try {
        outgoing.end(data.subarray(splitAt));
      } catch {
        // The gateway may have already closed the socket. Either outcome must
        // leave the durable session state unchanged.
      }
    },
    destroy() {
      outgoing.destroy();
    },
  };
}

describe("gateway active-turn durability", () => {
  it("does not publish terminal completion before the assistant is durable", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "reasoning.delta", payload: { text: "Verified evidence" } });
          options.emit({ type: "message.delta", payload: { text: "Durable answer" } });
          options.emit({ type: "message.complete", payload: { text: "Durable answer", status: "complete" } });
          entered();
          await gate;
          return {
            text: "Durable answer",
            parts: [
              { type: "reasoning", text: "Verified evidence" },
              { type: "text", text: "Durable answer" },
            ],
            status: "complete",
          };
        },
      }),
    });
    const session = await createSession();
    const stream = await openEventStream(session.id);
    try {
      await sendPrompt(session.id);
      await started;
      await vi.waitFor(() => expect(stream.events.some((event) => event.type === "message.delta")).toBe(true));
      expect(stream.events.some((event) => event.type === "message.complete")).toBe(false);

      release();
      await vi.waitFor(() => expect(stream.events.some((event) => event.type === "message.complete")).toBe(true));
      const state = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
      expect(state.messages[session.id].at(-1)).toMatchObject({
        role: "assistant",
        content: "Durable answer",
        pending: false,
        turnStatus: "complete",
      });
    } finally {
      stream.close();
    }
  });

  it("keeps streamed output when a provider returns an empty aggregate result", async () => {
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "reasoning.delta", payload: { text: "Streamed reasoning" } });
          options.emit({ type: "message.delta", payload: { text: "Streamed answer" } });
          options.emit({ type: "message.complete", payload: { text: "", status: "complete" } });
          return { text: "", parts: [], status: "complete" };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);

    await vi.waitFor(async () => {
      const history = await messages(session.id);
      expect(history.at(-1)).toMatchObject({
        role: "assistant",
        content: "Streamed answer",
        pending: false,
        turnStatus: "complete",
        parts: [
          { type: "reasoning", text: "Streamed reasoning" },
          { type: "text", text: "Streamed answer" },
        ],
      });
    });
  });

  it("keeps terminal-only output when the provider omits an aggregate result", async () => {
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "message.complete", payload: { text: "Terminal-only answer", status: "complete" } });
          return { text: "", parts: [], status: "complete" };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);

    await vi.waitFor(async () => {
      const history = await messages(session.id);
      expect(history.at(-1)).toMatchObject({
        role: "assistant",
        content: "Terminal-only answer",
        pending: false,
        turnStatus: "complete",
        parts: [{ type: "text", text: "Terminal-only answer" }],
      });
    });
  });

  it("keeps the streamed execution trace when the terminal result is text-only", async () => {
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "reasoning.delta", payload: { text: "Checked evidence" } });
          options.emit({ type: "tool.start", payload: { tool_call_id: "call-trace", name: "read_file", args: { path: "README.md" } } });
          options.emit({ type: "tool.complete", payload: { tool_call_id: "call-trace", name: "read_file", result: "ok" } });
          options.emit({ type: "message.delta", payload: { text: "Final answer" } });
          options.emit({ type: "message.complete", payload: { text: "Final answer", status: "complete" } });
          return {
            text: "Final answer",
            parts: [{ type: "text", text: "Final answer" }],
            status: "complete",
          };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);

    await vi.waitFor(async () => {
      const history = await messages(session.id);
      expect(history.at(-1)?.parts).toEqual([
        { type: "reasoning", text: "Checked evidence" },
        expect.objectContaining({ type: "tool", toolCallId: "call-trace", name: "read_file", result: "ok", running: false }),
        { type: "text", text: "Final answer" },
      ]);
    });
  });

  it("releases a session after a terminal persistence failure", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          calls += 1;
          if (calls === 1) {
            options.emit({ type: "message.delta", payload: { text: "Unsaved answer" } });
            entered();
            await gate;
          }
          return { text: calls === 1 ? "Unsaved answer" : "Recovered answer", parts: [], status: "complete" };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);
    await started;
    const flushFailure = vi.spyOn(SessionStore.prototype, "flush").mockRejectedValueOnce(new Error("simulated disk full"));
    release();

    await vi.waitFor(async () => {
      const listed = await request<{ sessions: Array<{ id: string; status?: string }> }>("/api/sessions");
      expect(listed.sessions.find((entry) => entry.id === session.id)?.status).toBe("idle");
    });
    flushFailure.mockRestore();

    await expect(sendPrompt(session.id, "Try again")).resolves.toMatchObject({ status: "streaming" });
    await vi.waitFor(async () => {
      const history = await messages(session.id);
      expect(history.some((message) => message.content === "Recovered answer")).toBe(true);
    });
  });

  it("acknowledges cancel only after forcing a hung turn into durable interrupted history", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "reasoning.delta", payload: { text: "Inspected the project" } });
          options.emit({
            type: "subagent.start",
            payload: { subagent_id: "child-hung", goal: "Inspect the project", model: "worker" },
          });
          options.emit({
            type: "tool.start",
            payload: { tool_call_id: "call-hung", name: "delegate_read", args: { task: "Inspect" } },
          });
          options.emit({
            type: "tool.progress",
            payload: { tool_call_id: "call-hung", name: "delegate_read", text: "Waiting for worker" },
          });
          options.emit({ type: "message.delta", payload: { text: "Partial finding" } });
          entered();
          await new Promise(() => {});
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);
    await started;

    const cancelled = await request<{ ok: boolean; status: string }>("/api/cancel", {
      method: "POST",
      body: JSON.stringify({ session: session.id }),
    });
    expect(cancelled).toMatchObject({ ok: true, status: "interrupted" });
    expect(cancelled).toHaveProperty("message_id");

    const history = await messages(session.id);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.at(-1)).toMatchObject({
      content: "Partial finding",
      pending: false,
      turnStatus: "interrupted",
      parts: [
        { type: "reasoning", text: "Inspected the project" },
        expect.objectContaining({
          type: "tool",
          toolCallId: "call-hung",
          name: "delegate_read",
          running: false,
          error: "tool_interrupted",
        }),
        { type: "text", text: "Partial finding" },
      ],
    });
    const status = await request<{ agents: Array<{ id: string; status: string }> }>("/api/status");
    expect(status.agents.find((agent) => agent.id === "child-hung")?.status).toBe("interrupted");
  });

  it("releases a force-cancelled session for the next prompt while the old provider stays hung", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          calls += 1;
          if (calls === 1) {
            options.emit({ type: "message.delta", payload: { text: "First partial" } });
            entered();
            await new Promise(() => {});
          }
          return {
            text: "Second answer",
            parts: [{ type: "text", text: "Second answer" }],
            status: "complete",
          };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id, "First request");
    await started;
    await request("/api/cancel", { method: "POST", body: JSON.stringify({ session: session.id }) });

    await expect(sendPrompt(session.id, "Second request")).resolves.toMatchObject({ status: "streaming" });
    await vi.waitFor(async () => {
      const history = await messages(session.id);
      expect(history.some((message) => message.content === "Second answer")).toBe(true);
    });
  });

  it("bounds shutdown and recovers a live draft after restart", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "reasoning.delta", payload: { text: "Long-running thought" } });
          options.emit({
            type: "tool.start",
            payload: { tool_call_id: "call-close", name: "delegate_read", args: { task: "Research" } },
          });
          options.emit({ type: "message.delta", payload: { text: "Recovered partial" } });
          entered();
          await new Promise(() => {});
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);
    await started;

    const closing = server!.close();
    await expect(Promise.race([
      closing.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])).resolves.toBe("closed");
    server = null;

    server = await startGateway({ dataDir, preferredPort: 0 }) as GatewayServer;
    const history = await messages(session.id);
    expect(history.at(-1)).toMatchObject({
      role: "assistant",
      content: "Recovered partial",
      pending: false,
      turnStatus: "interrupted",
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          toolCallId: "call-close",
          running: false,
          error: "tool_interrupted",
        }),
      ]),
    });
  });

  it("fences a late interrupted provider result after shutdown has closed durable state", async () => {
    let entered!: () => void;
    let release!: () => void;
    let returned!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const returnedLate = new Promise<void>((resolve) => { returned = resolve; });
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          options.emit({ type: "message.delta", payload: { text: "Durable partial" } });
          entered();
          await gate;
          returned();
          return {
            text: "Late interrupted result",
            parts: [{ type: "text", text: "Late interrupted result" }],
            status: "interrupted",
            route: { providerId: options.providerId, accountId: options.providerAccountId },
          };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id);
    await started;

    await server!.close();
    server = null;
    const before = await readFile(join(dataDir, "state.json"), "utf8");
    release();
    await returnedLate;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = await readFile(join(dataDir, "state.json"), "utf8");
    expect(after).toBe(before);
  });

  it("registers cancellation before asynchronous Skills setup", async () => {
    let setupEntered!: () => void;
    let releaseSetup!: () => void;
    const entered = new Promise<void>((resolve) => { setupEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSetup = resolve; });
    const runtimeSkills = vi.spyOn(SkillsStore.prototype, "runtimeSkills").mockImplementation(async () => {
      setupEntered();
      await gate;
      return { skills: [] } as never;
    });
    const engineLoader = vi.fn(async () => ({ runKyreiChat: vi.fn() }));

    try {
      await start({ engineLoader });
      const session = await createSession();
      await sendPrompt(session.id);
      await entered;
      await expect(request("/api/cancel", {
        method: "POST",
        body: JSON.stringify({ session: session.id }),
      })).resolves.toMatchObject({ ok: true, status: "interrupted" });
      releaseSetup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(engineLoader).not.toHaveBeenCalled();
    } finally {
      releaseSetup?.();
      runtimeSkills.mockRestore();
    }
  });

  it("does not persist a partial session PATCH that completes after gateway shutdown", async () => {
    await start({
      engineLoader: async () => ({ listModels: () => [], runKyreiChat: async () => ({ text: "", parts: [], status: "complete" }) }),
    });
    const session = await createSession();
    const upsertSession = vi.spyOn(SessionStore.prototype, "upsertSession");
    upsertSession.mockClear();
    const partial = startPartialJsonRequest(
      `/api/sessions/${session.id}`,
      "PATCH",
      JSON.stringify({ title: "Late title must not persist" }),
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await server!.close();
      server = null;
      const before = await readFile(join(dataDir, "state.json"), "utf8");

      // Finishing the body after close() resolves must not revive the request
      // handler or schedule a SessionStore flush.
      partial.finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(upsertSession).not.toHaveBeenCalled();
      await expect(readFile(join(dataDir, "state.json"), "utf8")).resolves.toBe(before);
    } finally {
      partial.destroy();
      upsertSession.mockRestore();
    }
  });

  it("fences a non-cooperative late approval callback after force shutdown", async () => {
    const approvalId = "approval-late-shutdown";
    const toolCallId = "call-late-shutdown";
    let continuationEntered!: () => void;
    let releaseContinuation!: () => void;
    let callbackFinished!: () => void;
    let callbackError = "";
    const entered = new Promise<void>((resolve) => { continuationEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseContinuation = resolve; });
    const callbackDone = new Promise<void>((resolve) => { callbackFinished = resolve; });
    let calls = 0;
    await start({
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (options: Record<string, any>) => {
          calls += 1;
          if (calls === 1) {
            options.emit({
              type: "approval.request",
              payload: { approval_id: approvalId, tool_call_id: toolCallId, name: "run_command" },
            });
            options.emit({ type: "message.complete", payload: { text: "Approval required", status: "awaiting_approval" } });
            return { text: "Approval required", parts: [], status: "awaiting_approval" };
          }

          continuationEntered();
          await gate;
          try {
            await options.onApprovalConsumed(approvalId);
          } catch (error) {
            callbackError = error instanceof Error ? error.message : String(error);
          } finally {
            callbackFinished();
          }
          return { text: "Late result", parts: [], status: "interrupted" };
        },
      }),
    });
    const session = await createSession();
    await sendPrompt(session.id, "Request a protected action");
    await vi.waitFor(async () => {
      const history = await messages(session.id);
      expect(history.at(-1)?.turnStatus).toBe("awaiting_approval");
    });

    await request(`/api/sessions/${session.id}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });
    await entered;

    await server!.close();
    server = null;
    const before = await readFile(join(dataDir, "state.json"), "utf8");
    releaseContinuation();
    await callbackDone;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(callbackError).toBe("gateway_shutdown");
    await expect(readFile(join(dataDir, "state.json"), "utf8")).resolves.toBe(before);
  });
});
