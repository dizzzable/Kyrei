import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };

let dataDir = "";
let server: GatewayServer | null = null;
let curateCalls: Array<{ sessionId: string; applyModeOverride?: string; messageCount: number }> = [];

// Tiny idle window so the test does not wait. The gateway reads the curator
// config raw (not Zod-reparsed), and the scheduler honors any positive idleMs,
// so a short value keeps the fire/guard assertions fast and deterministic.
const IDLE_MS = 150;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-idle-"));
  curateCalls = [];
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
    workspace: dataDir,
    engine: {
      memory: {
        sessionMirror: { enabled: false, readSearch: false, enginePrimary: false },
        curator: {
          enabled: true,
          autoOnIdle: true,
          idleMs: IDLE_MS,
          autoApplyMode: "apply_all",
          useLlm: false,
        },
      },
    },
  }, null, 2)}\n`, "utf8");
  // Pre-seed credentials so the default provider is ready at boot — a runtime
  // PUT does not settle deterministically before the async turn under vitest.
  await writeFile(join(dataDir, "kyrei-secrets.json"), `${JSON.stringify({
    version: 3,
    providers: { "default-openai-compatible": { apiKey: "idle-test-key" } },
    accounts: {},
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

const fakeEngine = () => ({
  async runKyreiChat(options: any) {
    options.emit?.({ type: "message.complete", payload: { text: "done", status: "complete" } });
    return {
      text: "done",
      status: "complete",
      parts: [{ type: "text", text: "done" }],
      responseMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      attempts: [],
      route: { providerId: options.providerId, modelId: options.model },
    };
  },
  async curateSession(input: any) {
    curateCalls.push({
      sessionId: input.sessionId,
      applyModeOverride: input.applyModeOverride,
      messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
    });
    return { ok: true, sessionId: input.sessionId, via: "heuristic", proposals: [], applied: ["notes"] };
  },
  buildModel() {
    return {} as unknown;
  },
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
  const body = await response.json() as T;
  return { status: response.status, body };
}

async function bootGateway() {
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => fakeEngine(),
  }) as GatewayServer;
}

const waitForCurate = async (min: number, timeoutMs = 3_000) => {
  const started = Date.now();
  while (curateCalls.length < min && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Wait until the session's assistant turn reaches a terminal, non-error status. */
async function waitForTurnComplete(sessionId: string, timeoutMs = 5_000): Promise<string> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const res = await request<{ messages: Array<{ role: string; turnStatus?: string; pending?: boolean }> }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    const assistant = [...(res.body.messages ?? [])].reverse().find((m) => m.role === "assistant");
    last = assistant?.turnStatus ?? (assistant?.pending ? "pending" : "");
    if (assistant && assistant.pending !== true && last && last !== "pending") return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

describe("gateway idle auto-curation", () => {
  it("fires curator after idle with the configured autoApplyMode", async () => {
    await bootGateway();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.body.id, text: "remember we use vitest" }),
    });
    // Curator must NOT run synchronously on turn completion.
    expect(curateCalls.length).toBe(0);
    // The turn must actually complete (idle only arms on a non-error terminal turn).
    expect(await waitForTurnComplete(session.body.id)).toBe("complete");
    // After the idle window it should fire exactly once, with the auto apply mode.
    await waitForCurate(1);
    expect(curateCalls.length).toBe(1);
    expect(curateCalls[0]?.sessionId).toBe(session.body.id);
    expect(curateCalls[0]?.applyModeOverride).toBe("apply_all");
  });

  it("does not re-distill an idle session with no new messages (curatedAtSeq guard)", async () => {
    await bootGateway();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.body.id, text: "first turn" }),
    });
    await waitForCurate(1);
    expect(curateCalls.length).toBe(1);
    // Wait well past several idle windows without any new activity.
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The guard must prevent any further curation of the unchanged session.
    expect(curateCalls.length).toBe(1);
  });

  it("re-arms and fires again after a new turn adds messages", async () => {
    await bootGateway();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.body.id, text: "first turn" }),
    });
    await waitForCurate(1);
    expect(curateCalls.length).toBe(1);
    // A new turn adds messages, so the next idle window should distill again.
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.body.id, text: "second turn with new facts" }),
    });
    await waitForCurate(2);
    expect(curateCalls.length).toBe(2);
    expect(curateCalls[1]?.messageCount).toBeGreaterThan(curateCalls[0]?.messageCount ?? 0);
  });
});
