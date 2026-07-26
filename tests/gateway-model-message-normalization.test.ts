import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };

let dataDir = "";
let workspace = "";
let server: GatewayServer | null = null;
/** Messages the engine was handed, per turn. */
let seen: unknown[][] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-modelmsg-"));
  workspace = await mkdtemp(join(tmpdir(), "kyrei-workspace-modelmsg-"));
  seen = [];
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
    workspace,
    engine: {
      memory: { sessionMirror: { enabled: false, readSearch: false, enginePrimary: false } },
    },
  }, null, 2)}\n`, "utf8");
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

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

describe("persisted model messages", () => {
  it("keeps a string-content assistant message so the next turn sees the final answer", async () => {
    // Regression: internalModelMessages dropped any message whose `content`
    // was not an array. The engine legitimately emits
    // `{role:"assistant", content:"<text>"}` on the host-enforced diagnostic
    // path and on a recovery pass with no responseMessages — so a multi-pass
    // turn persisted the tool calls from pass 1 and threw away the final answer
    // from pass 2. Because the surviving structured messages made the list
    // non-empty, convoFor's `message.content` fallback did not kick in either,
    // and the model re-derived work it had already reported.
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        listModels: () => [],
        runKyreiChat: async (opts: { messages?: unknown[] }) => {
          seen.push(opts.messages ?? []);
          return {
            text: "final answer",
            parts: [],
            status: "complete",
            responseMessages: [
              // pass 1: structured tool activity
              { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} }] },
              { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: "ok" }] },
              // pass 2: a plain string answer
              { role: "assistant", content: "final answer" },
            ],
          };
        },
      }),
    });

    // A prompt is refused until the active provider holds a credential.
    const config = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "model-message-normalization-test-key" }),
    });

    const created = await request<{ id: string }>("/api/sessions", { method: "POST", body: "{}" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: created.id, text: "first" }),
    });
    await waitFor(() => seen.length >= 1);

    // Second turn: the restored conversation must carry the string answer.
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: created.id, text: "second" }),
    });
    await waitFor(() => seen.length >= 2);
    const replayed = JSON.stringify(seen[1]);
    expect(replayed).toContain("final answer");
    // And the structured tool activity is still there.
    expect(replayed).toContain("read_file");
  });
});
