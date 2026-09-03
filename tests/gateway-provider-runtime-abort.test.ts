import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

/**
 * A configuration save must not cancel work it has nothing to do with.
 *
 * `PUT /api/config` invalidated EVERY known provider runtime unconditionally,
 * and every turn registered EVERY configured provider as in flight. So the
 * Settings autosave — one `PUT { engine }` 500 ms after a keystroke — aborted
 * every running turn in every session, and the turn was persisted `interrupted`
 * with empty text, no `errorCode` and no error event. From the user's seat that
 * is indistinguishable from the model answering nothing.
 *
 * These tests pin both halves: an unrelated save must not touch a turn, a real
 * credential change must still stop it, and a stop the user did not ask for
 * must say why.
 */

type GatewayServer = { port: number; token: string; close(): Promise<void> };
type PublicMessage = {
  role: string;
  content: string;
  turnStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  parts?: Array<Record<string, unknown>>;
};
type SseEvent = { type: string; payload?: Record<string, unknown> };

const HOOK_TIMEOUT_MS = 30_000;

let dataDir = "";
let server: GatewayServer;
/** Resolves the parked turn for one session id. */
const release = new Map<string, () => void>();
/** Session ids whose turn has streamed its parts and is now waiting. */
const parked = new Set<string>();
/** Model messages the engine was handed, per session, for the latest turn. */
const seenMessages = new Map<string, Array<Record<string, unknown>>>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error ?? String(response.status)), { status: response.status });
  return body;
}

async function openEventStream(sessionId: string) {
  const events: SseEvent[] = [];
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
      if (data) events.push(JSON.parse(data) as SseEvent);
      boundary = buffer.indexOf("\n\n");
    }
  });
  return { events, close: () => { incoming.destroy(); outgoing.destroy(); } };
}

async function waitFor(label: string, predicate: () => boolean, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ANSWER = "Answer delivered after the save.";

/**
 * Streams reasoning and tool activity, then waits like a provider stream that
 * has not produced its answer yet. It answers only when the test releases it,
 * so "the save did not touch this turn" is observed rather than inferred from a
 * timeout.
 */
const engineLoader = async () => ({
  listModels: () => [],
  runKyreiChat: async (options: Record<string, any>) => {
    const sessionId = String(options.sessionId);
    seenMessages.set(sessionId, [...(options.messages ?? [])]);
    options.emit({ type: "reasoning.delta", payload: { text: "Reading the task" } });
    options.emit({
      type: "tool.start",
      payload: { tool_call_id: `${sessionId}-call-1`, name: "read_file", args: { path: "AGENTS.md" } },
    });
    options.emit({
      type: "tool.complete",
      payload: { tool_call_id: `${sessionId}-call-1`, name: "read_file", result: "ok", duration_s: 0.01 },
    });
    options.emit({
      type: "tool.start",
      payload: { tool_call_id: `${sessionId}-call-2`, name: "grep_search", args: { query: "abort" } },
    });
    await new Promise<void>((resolve, reject) => {
      release.set(sessionId, resolve);
      const fail = () => {
        const reason = options.abortSignal.reason;
        reject(reason instanceof Error ? reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (options.abortSignal.aborted) fail();
      else options.abortSignal.addEventListener("abort", fail, { once: true });
      parked.add(sessionId);
    });
    options.emit({
      type: "tool.complete",
      payload: { tool_call_id: `${sessionId}-call-2`, name: "grep_search", result: "3 matches", duration_s: 0.02 },
    });
    options.emit({ type: "message.delta", payload: { text: ANSWER } });
    options.emit({ type: "message.complete", payload: { text: ANSWER, status: "complete" } });
    return { text: ANSWER, status: "complete", parts: [{ type: "text", text: ANSWER }] };
  },
});

beforeEach(async () => {
  release.clear();
  parked.clear();
  seenMessages.clear();
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-provider-runtime-abort-"));
  // No SQLite mirror: it holds file handles that make Windows cleanup flaky and
  // contributes nothing to the abort boundary under test.
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
    engine: { memory: { sessionMirror: { enabled: false, readSearch: false, enginePrimary: false } } },
  }, null, 2)}\n`, "utf8");
  server = await startGateway({ dataDir, preferredPort: 0, engineLoader }) as GatewayServer;
  const config = await request<{ activeProviderId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "runtime-abort-test-key" }),
  });
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  for (const resolve of release.values()) resolve();
  try {
    await server?.close();
  } catch {
    /* ignore close races */
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}, HOOK_TIMEOUT_MS);

async function startParkedTurn(text = "Explain the abort path") {
  const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
  const stream = await openEventStream(session.id);
  await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text }) });
  await waitFor(`turn parked on ${session.id}`, () => parked.has(session.id));
  await waitFor(`tool.start on ${session.id}`, () => stream.events.some((event) => event.type === "tool.start"));
  return { id: session.id, stream };
}

async function lastAssistant(sessionId: string) {
  const { messages } = await request<{ messages: PublicMessage[] }>(`/api/sessions/${sessionId}/messages`);
  return messages.filter((message) => message.role === "assistant").at(-1);
}

const terminalFrames = (stream: { events: SseEvent[] }) =>
  stream.events.filter((event) => event.type === "message.complete");

async function expectStillRunning(session: { id: string; stream: { events: SseEvent[] } }) {
  // Give the abort every chance to arrive before declaring the turn untouched.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(terminalFrames(session.stream)).toHaveLength(0);
  release.get(session.id)!();
  await waitFor(`completion on ${session.id}`, () => terminalFrames(session.stream).length > 0);
  const assistant = await lastAssistant(session.id);
  expect(assistant).toMatchObject({ turnStatus: "complete", content: ANSWER });
  expect(assistant?.errorCode).toBeUndefined();
}

async function expectInterruptedWithReason(session: { id: string; stream: { events: SseEvent[] } }) {
  await waitFor(`interruption on ${session.id}`, () => terminalFrames(session.stream).length > 0);
  expect(terminalFrames(session.stream).at(-1)?.payload).toMatchObject({
    status: "interrupted",
    error_code: "provider_runtime_changed",
  });
  const assistant = await lastAssistant(session.id);
  expect(assistant).toMatchObject({ turnStatus: "interrupted", errorCode: "provider_runtime_changed" });
}

describe("a config save must not cancel unrelated turns", () => {
  it("keeps every running turn when the save touches only the engine block", async () => {
    const sessions = [await startParkedTurn(), await startParkedTurn("Second session, same time")];
    const config = await request<{ engine?: Record<string, unknown> }>("/api/config");
    const engine = { ...(config.engine ?? {}), verbosity: "concise" };

    await request("/api/config", { method: "PUT", body: JSON.stringify({ engine }) });

    for (const session of sessions) await expectStillRunning(session);
  }, HOOK_TIMEOUT_MS);

  it("keeps a running turn when the save changes a different provider", async () => {
    await request("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: {
          id: "unused-provider",
          name: "Unused provider",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:1/v1",
          models: [{ id: "unused-model", name: "Unused model" }],
          enabled: true,
          requiresApiKey: false,
        },
        activate: false,
      }),
    });
    const session = await startParkedTurn();
    const withProviders = await request<{ providers: Array<Record<string, unknown>> }>("/api/config");

    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        providers: withProviders.providers.map((provider) => provider.id === "unused-provider"
          ? { ...provider, name: "Unused provider, renamed" }
          : provider),
      }),
    });

    await expectStillRunning(session);
  }, HOOK_TIMEOUT_MS);

  it("keeps a running turn when another provider's account pool is patched", async () => {
    // Registered BEFORE the turn opens. That ordering is the point: the turn
    // used to claim every configured provider as in flight, so patching this
    // one aborted a session that never sends a byte to it.
    await request("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: {
          id: "spare-provider",
          name: "Spare provider",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:2/v1",
          models: [{ id: "spare-model", name: "Spare model" }],
          enabled: true,
          requiresApiKey: false,
        },
        activate: false,
      }),
    });
    const session = await startParkedTurn();

    await request("/api/providers/spare-provider/pool", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, strategy: "balanced", sessionAffinity: true }),
    });

    await expectStillRunning(session);
  }, HOOK_TIMEOUT_MS);

  it("keeps a running turn when another provider's credentials are replaced", async () => {
    await request("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: {
          id: "other-keyed-provider",
          name: "Other keyed provider",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:3/v1",
          models: [{ id: "other-model", name: "Other model" }],
          enabled: true,
          requiresApiKey: true,
        },
        activate: false,
      }),
    });
    await request("/api/providers/other-keyed-provider/secret", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "other-provider-key" }),
    });
    const session = await startParkedTurn();

    await request("/api/providers/other-keyed-provider/secret", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "other-provider-key-rotated" }),
    });

    await expectStillRunning(session);
  }, HOOK_TIMEOUT_MS);
});

describe("a runtime change that does reach the turn says so", () => {
  it("interrupts and reports when the running provider's credentials are replaced", async () => {
    const session = await startParkedTurn();
    const config = await request<{ activeProviderId: string }>("/api/config");

    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "rotated-key" }),
    });

    await expectInterruptedWithReason(session);
  }, HOOK_TIMEOUT_MS);

  it("interrupts and reports when a config save rewrites the running provider", async () => {
    const session = await startParkedTurn();
    const config = await request<{
      activeProviderId: string;
      providers: Array<Record<string, unknown>>;
    }>("/api/config");

    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        providers: config.providers.map((provider) => provider.id === config.activeProviderId
          ? { ...provider, baseURL: "http://127.0.0.1:9/v1" }
          : provider),
      }),
    });

    await expectInterruptedWithReason(session);
  }, HOOK_TIMEOUT_MS);

  it("stays quiet when the user cancelled the turn themselves", async () => {
    const session = await startParkedTurn();

    await request("/api/cancel", { method: "POST", body: JSON.stringify({ session: session.id }) });

    await waitFor("cancellation", () => terminalFrames(session.stream).length > 0);
    expect(terminalFrames(session.stream).at(-1)?.payload).toMatchObject({ status: "interrupted" });
    expect(terminalFrames(session.stream).at(-1)?.payload?.error_code).toBeUndefined();
    const assistant = await lastAssistant(session.id);
    expect(assistant?.turnStatus).toBe("interrupted");
    expect(assistant?.errorCode).toBeUndefined();
  }, HOOK_TIMEOUT_MS);

  it("keeps a reason-only turn out of the next turn's model history", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    const stream = await openEventStream(session.id);
    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "First ask" }) });
    await waitFor("turn parked", () => parked.has(session.id));
    const config = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "rotated-key" }),
    });
    await waitFor("interruption", () => terminalFrames({ events: stream.events }).length > 0);
    expect((await lastAssistant(session.id))?.errorCode).toBe("provider_runtime_changed");

    parked.delete(session.id);
    await request("/api/prompt", { method: "POST", body: JSON.stringify({ session: session.id, text: "Second ask" }) });
    await waitFor("second turn parked", () => parked.has(session.id));

    // The stopped turn's own record exists for the human. Replaying it as
    // `{ role: "assistant", content: "" }` adds no context and strict providers
    // reject it outright.
    const history = seenMessages.get(session.id) ?? [];
    expect(history.map((message) => message.role)).toEqual(["user", "user"]);
    stream.close();
  }, HOOK_TIMEOUT_MS);
});
