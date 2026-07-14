import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let workspace = "";
let server: { port: number; token: string; close(): Promise<void> };
const GATEWAY_HOOK_TIMEOUT_MS = 30_000;

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
  if (!response.ok) throw Object.assign(new Error(body.error ?? `${response.status}`), { status: response.status });
  return body;
}

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-checkpoint-"));
  workspace = join(dataDir, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "value.txt"), "original", "utf8");

  const engineLoader = vi.fn(async () => ({
    runKyreiChat: vi.fn(async (options: Record<string, any>) => {
      const snapshotId = "turn-snapshot-0001";
      const snapshotDir = join(workspace, ".kyrei", "snapshots", snapshotId);
      await mkdir(join(snapshotDir, "files", "src"), { recursive: true });
      await writeFile(join(snapshotDir, "files", "src", "value.txt"), "original", "utf8");
      await writeFile(join(snapshotDir, "manifest.json"), JSON.stringify({
        id: snapshotId,
        ts: Date.now(),
        workspace: await realpath(workspace),
        files: [{ rel: "src/value.txt", existed: true }],
      }), "utf8");
      await writeFile(join(workspace, "src", "value.txt"), "changed", "utf8");
      options.emit({ type: "tool.start", payload: { tool_call_id: "call-1", name: "edit_file", args: { path: "src/value.txt" } } });
      options.emit({
        type: "tool.complete",
        payload: {
          tool_call_id: "call-1",
          name: "edit_file",
          result: "updated",
          inline_diff: "-original\n+changed",
          snapshot_id: snapshotId,
          duration_s: 0.01,
        },
      });
      options.emit({ type: "message.complete", payload: { text: "done", status: "complete" } });
      return {
        text: "done",
        status: "complete",
        parts: [{
          type: "tool",
          toolCallId: "call-1",
          name: "edit_file",
          result: "updated",
          inlineDiff: "-original\n+changed",
          snapshotId,
          running: false,
        }],
        route: { providerId: options.providerId, modelId: options.model },
      };
    }),
  }));
  server = await startGateway({ dataDir, preferredPort: 0, engineLoader });
  await request("/api/config", { method: "PUT", body: JSON.stringify({ workspace }) });
  const config = await request<{ activeProviderId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "checkpoint-test-key" }),
  });
}, GATEWAY_HOOK_TIMEOUT_MS);

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}, GATEWAY_HOOK_TIMEOUT_MS);

describe("gateway turn checkpoints", () => {
  it("never treats a nested session action as the session resource", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/${session.id}/messages`,
      {
        method: "DELETE",
        headers: { "X-Kyrei-Gateway-Token": server.token },
      },
    );

    expect(response.status).toBe(404);
    const sessions = await request<{ sessions: Array<{ id: string }> }>("/api/sessions");
    expect(sessions.sessions.some((candidate) => candidate.id === session.id)).toBe(true);
  });

  it("restores code, truncates messages, and returns the prompt draft", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    const messageId = "msg-user-checkpoint-0001";
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Change the file", messageId }),
    });
    await waitFor(async () => {
      const [messages, sessions] = await Promise.all([
        request<{ messages: unknown[] }>(`/api/sessions/${session.id}/messages`),
        request<{ sessions: Array<{ id: string; activity?: { active: boolean; phase: string } }> }>("/api/sessions"),
      ]);
      const activity = sessions.sessions.find(candidate => candidate.id === session.id)?.activity;
      return messages.messages.length === 2 && activity?.active === false && activity.phase === "complete";
    });
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("changed");

    const sessions = await request<{ sessions: Array<{ id: string; activity?: { active: boolean; toolCount: number; phase: string } }> }>("/api/sessions");
    expect(sessions.sessions.find(candidate => candidate.id === session.id)?.activity)
      .toMatchObject({ active: false, toolCount: 1, phase: "complete" });

    const rewound = await request<{
      draft: string;
      messages: unknown[];
      restoredSnapshots: number;
      restoredFiles: number;
    }>(`/api/sessions/${session.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ messageId }),
    });

    expect(rewound).toMatchObject({
      draft: "Change the file",
      messages: [],
      restoredSnapshots: 1,
      restoredFiles: 1,
    });
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("original");
  });

  it("reserves the session before awaiting a rewind body", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    let release!: () => void;
    const heldResponse = new Promise<number>((resolveResponse, rejectResponse) => {
      const pending = httpRequest({
        hostname: "127.0.0.1",
        port: server.port,
        path: `/api/sessions/${session.id}/rewind`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kyrei-Gateway-Token": server.token,
        },
      }, response => {
        response.resume();
        response.on("end", () => resolveResponse(response.statusCode ?? 0));
      });
      pending.on("error", rejectResponse);
      pending.write('{"messageId":"');
      release = () => pending.end('msg-user-missing-0001"}');
    });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));

    const prompt = await fetch(`http://127.0.0.1:${server.port}/api/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
      },
      body: JSON.stringify({ session: session.id, text: "must not start" }),
    });
    const removal = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { "X-Kyrei-Gateway-Token": server.token },
    });

    expect(prompt.status).toBe(409);
    expect(removal.status).toBe(409);
    release();
    await expect(heldResponse).resolves.toBe(404);
  });

  it("refuses to apply a checkpoint after the workspace changes", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    const messageId = "msg-user-checkpoint-0002";
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Change in workspace A", messageId }),
    });
    await waitFor(async () => (await request<{ messages: unknown[] }>(`/api/sessions/${session.id}/messages`)).messages.length === 2);
    const otherWorkspace = join(dataDir, "other-workspace");
    await mkdir(otherWorkspace, { recursive: true });
    await request("/api/config", { method: "PUT", body: JSON.stringify({ workspace: otherWorkspace }) });

    const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/rewind`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
      },
      body: JSON.stringify({ messageId }),
    });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe("checkpoint_workspace_changed");
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("changed");
  });
});
