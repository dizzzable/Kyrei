import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): Promise<void> };
let runKyreiChat: ReturnType<typeof vi.fn>;
let approvalExpiresAt: string | undefined;
const APPROVAL_ID = "approval-12345678";
const TOOL_CALL_ID = "call-approval-1";

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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

async function sessionMessages(sessionId: string): Promise<Array<Record<string, any>>> {
  return (await request<{ messages: Array<Record<string, any>> }>(`/api/sessions/${sessionId}/messages`)).messages;
}

async function waitForPendingApproval(sessionId: string): Promise<void> {
  await waitFor(async () => {
    const last = (await sessionMessages(sessionId)).at(-1);
    return last?.role === "assistant"
      && last?.pending !== true
      && last?.turnStatus === "awaiting_approval"
      && Array.isArray(last.parts)
      && last.parts.some((part: Record<string, unknown>) => (
        part.type === "approval" && part.approvalId === APPROVAL_ID && part.status === "pending"
      ));
  });
}

async function waitForSettledMessageCount(sessionId: string, count: number): Promise<void> {
  await waitFor(async () => {
    const messages = await sessionMessages(sessionId);
    return messages.length === count && messages.at(-1)?.pending !== true;
  });
}

function startPartialJsonRequest(path: string, payload: string) {
  const data = Buffer.from(payload, "utf8");
  const splitAt = Math.max(1, data.byteLength - 2);
  const request = nodeRequest({
    hostname: "127.0.0.1",
    port: server.port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": data.byteLength,
      "X-Kyrei-Gateway-Token": server.token,
    },
  });
  // Shutdown intentionally terminates this request before its body is valid.
  request.on("error", () => undefined);
  request.write(data.subarray(0, splitAt));
  return {
    finish() {
      try {
        request.end(data.subarray(splitAt));
      } catch {
        // The shutdown response can already have closed the socket.
      }
    },
    destroy() {
      request.destroy();
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-approval-"));
  approvalExpiresAt = undefined;
  runKyreiChat = vi.fn(async (options: Record<string, any>) => {
    const last = options.messages.at(-1);
    if (last?.role === "tool") {
      const decision = last.content.find((part: Record<string, unknown>) => part.type === "tool-approval-response");
      const approved = decision?.approved === true;
      if (approved) {
        await options.onApprovalConsumed(APPROVAL_ID, TOOL_CALL_ID);
        options.emit({ type: "approval.consumed", payload: { approval_id: APPROVAL_ID, tool_call_id: TOOL_CALL_ID } });
        options.emit({
          type: "tool.complete",
          payload: { tool_call_id: TOOL_CALL_ID, name: "run_command", result: "tests passed", duration_s: 0.01 },
        });
      }
      const text = approved ? "Approved action completed." : "Protected action was not run.";
      options.emit({ type: "message.delta", payload: { text } });
      options.emit({ type: "message.complete", payload: { text, status: "complete" } });
      return {
        text,
        status: "complete",
        parts: approved
          ? [
              { type: "tool", toolCallId: TOOL_CALL_ID, name: "run_command", result: "tests passed", running: false },
              { type: "text", text },
            ]
          : [{ type: "text", text }],
        responseMessages: [
          ...(approved ? [{
            role: "tool",
            content: [{
              type: "tool-result",
              toolCallId: TOOL_CALL_ID,
              toolName: "run_command",
              output: { type: "text", value: "tests passed" },
            }],
          }] : []),
          { role: "assistant", content: [{ type: "text", text }] },
        ],
        attempts: [],
        route: { providerId: options.providerId, modelId: options.model },
      };
    }

    const sharedArgs = { command: "npm test" };
    options.emit({ type: "tool.start", payload: {
      tool_call_id: TOOL_CALL_ID,
      name: "run_command",
      args: sharedArgs,
    } });
    options.emit({ type: "approval.request", payload: {
      approval_id: APPROVAL_ID,
      tool_call_id: TOOL_CALL_ID,
      name: "run_command",
      args: sharedArgs,
      reason: "permission_rule_requires_confirmation",
    } });
    options.emit({ type: "message.complete", payload: { text: "", status: "awaiting_approval" } });
    return {
      text: "",
      status: "awaiting_approval",
      parts: [
        { type: "tool", toolCallId: TOOL_CALL_ID, name: "run_command", args: sharedArgs, running: false },
        {
          type: "approval",
          approvalId: APPROVAL_ID,
          toolCallId: TOOL_CALL_ID,
          name: "run_command",
          args: { command: "npm test" },
          reason: "permission_rule_requires_confirmation",
          status: "pending",
          ...(approvalExpiresAt ? { expiresAt: approvalExpiresAt } : {}),
        },
      ],
      responseMessages: [{
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: TOOL_CALL_ID, toolName: "run_command", input: sharedArgs },
          {
            type: "tool-approval-request",
            approvalId: APPROVAL_ID,
            toolCallId: TOOL_CALL_ID,
            signature: "signed-approval",
          },
        ],
      }],
      attempts: [],
      route: { providerId: options.providerId, modelId: options.model },
    };
  });
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => ({ runKyreiChat }),
  });
  const config = await request<{ activeProviderId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "approval-test-key" }),
  });
});

afterEach(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("gateway interactive tool approvals", () => {
  it("persists a signed pending request, resumes without a synthetic user message, and blocks replay", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({
        session: session.id,
        text: "Run the tests",
        modelParams: { effort: "high", contextWindowOverride: 96_000 },
      }),
    });
    await waitForPendingApproval(session.id);

    const pending = await request<{ messages: Array<Record<string, any>> }>(`/api/sessions/${session.id}/messages`);
    expect(pending.messages[1]?.parts).toContainEqual(expect.objectContaining({
      type: "approval",
      approvalId: APPROVAL_ID,
      status: "pending",
    }));
    expect(JSON.stringify(pending)).not.toContain("signed-approval");
    expect(JSON.stringify(pending)).not.toContain("modelMessages");
    expect(JSON.stringify(pending)).not.toContain("approvalModelParams");
    expect(runKyreiChat.mock.calls[0]?.[0].approvalSecret).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const response = await request<{ status: string }>(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      { method: "POST", body: JSON.stringify({ approved: true, reason: "User approved once" }) },
    );
    expect(response.status).toBe("streaming");
    await waitForSettledMessageCount(session.id, 3);

    const resumedMessages = runKyreiChat.mock.calls[1]?.[0].messages;
    expect(JSON.stringify(resumedMessages)).not.toContain("[CIRCULAR]");
    expect(resumedMessages).toContainEqual({
      role: "assistant",
      content: expect.arrayContaining([expect.objectContaining({
        type: "tool-call",
        toolCallId: TOOL_CALL_ID,
        input: { command: "npm test" },
      })]),
    });
    expect(runKyreiChat.mock.calls[1]?.[0].modelParams).toEqual({
      effort: "high",
      contextWindowOverride: 96_000,
    });
    expect(resumedMessages.at(-1)).toEqual({
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: APPROVAL_ID,
        approved: true,
        reason: "User approved once",
      }],
    });
    const stored = await request<{ messages: Array<Record<string, any>> }>(`/api/sessions/${session.id}/messages`);
    expect(stored.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(stored.messages[1]?.parts).toContainEqual(expect.objectContaining({
      type: "approval",
      status: "approved",
      consumedAt: expect.any(String),
    }));

    const replay = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kyrei-Gateway-Token": server.token,
        },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "approval_already_consumed" });
    expect(runKyreiChat).toHaveBeenCalledTimes(2);
  });

  it("resumes a pending signed approval after a full gateway restart", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Run after restart" }),
    });
    await waitForPendingApproval(session.id);
    const signingKeyBeforeRestart = runKyreiChat.mock.calls[0]?.[0].approvalSecret;

    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({ runKyreiChat }),
    });

    const response = await request<{ status: string }>(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      { method: "POST", body: JSON.stringify({ approved: true }) },
    );
    expect(response.status).toBe("streaming");
    await waitForSettledMessageCount(session.id, 3);

    expect(runKyreiChat.mock.calls[1]?.[0].approvalSecret).toBe(signingKeyBeforeRestart);
    expect(runKyreiChat.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: [expect.objectContaining({
        type: "tool-approval-response",
        approvalId: APPROVAL_ID,
        approved: true,
      })],
    });
    const stored = await request<{ messages: Array<Record<string, any>> }>(`/api/sessions/${session.id}/messages`);
    expect(stored.messages[1]?.parts).toContainEqual(expect.objectContaining({
      approvalId: APPROVAL_ID,
      status: "approved",
      consumedAt: expect.any(String),
    }));
  });

  it("does not resolve an approval whose request body is interrupted by gateway shutdown", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Wait for an explicit decision" }),
    });
    await waitForPendingApproval(session.id);

    const payload = JSON.stringify({ approved: true, reason: "must not apply after close" });
    const partial = startPartialJsonRequest(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      payload,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(Promise.race([
      server.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])).resolves.toBe("closed");
    // A delayed final chunk from an already accepted connection must not
    // resolve the approval after close() has returned.
    partial.finish();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    partial.destroy();

    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({ runKyreiChat }),
    });
    const restored = await sessionMessages(session.id);
    const approval = restored[1]?.parts?.find((part: Record<string, unknown>) => (
      part.type === "approval" && part.approvalId === APPROVAL_ID
    ));
    expect(approval).toMatchObject({ status: "pending" });
    expect(approval).not.toHaveProperty("consumedAt");
    expect(runKyreiChat).toHaveBeenCalledTimes(1);
  });

  it("unblocks later prompts when a newly restrictive policy consumes an approved receipt without an effect", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Request an action before policy changes" }),
    });
    await waitForPendingApproval(session.id);

    runKyreiChat.mockImplementationOnce(async (options: Record<string, any>) => {
      expect(options.messages.at(-1)).toMatchObject({
        role: "tool",
        content: [expect.objectContaining({ approvalId: APPROVAL_ID, approved: true })],
      });
      await options.onApprovalConsumed(APPROVAL_ID, TOOL_CALL_ID);
      options.emit({ type: "approval.consumed", payload: { approval_id: APPROVAL_ID, tool_call_id: TOOL_CALL_ID } });
      options.emit({ type: "message.complete", payload: { text: "Current policy denied the action.", status: "complete" } });
      return {
        text: "Current policy denied the action.",
        status: "complete",
        parts: [{ type: "text", text: "Current policy denied the action." }],
        responseMessages: [],
        attempts: [],
      };
    });
    await request(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      { method: "POST", body: JSON.stringify({ approved: true }) },
    );
    await waitForSettledMessageCount(session.id, 3);
    const stored = await request<{ messages: Array<Record<string, any>> }>(`/api/sessions/${session.id}/messages`);
    expect(stored.messages[1]?.parts).toContainEqual(expect.objectContaining({
      approvalId: APPROVAL_ID,
      status: "approved",
      consumedAt: expect.any(String),
    }));

    runKyreiChat.mockImplementationOnce(async (options: Record<string, any>) => {
      options.emit({ type: "message.complete", payload: { text: "Later prompt accepted.", status: "complete" } });
      return { text: "Later prompt accepted.", status: "complete", parts: [], responseMessages: [], attempts: [] };
    });
    await expect(request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Continue safely" }),
    })).resolves.toMatchObject({ status: "streaming" });
    await waitFor(async () => runKyreiChat.mock.calls.length === 3);
  });

  it("durably consumes a denial and accepts a later prompt", async () => {
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Do not run this command" }),
    });
    await waitForPendingApproval(session.id);

    const response = await request<{ status: string; approval: Record<string, unknown> }>(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      { method: "POST", body: JSON.stringify({ approved: false }) },
    );
    expect(response).toMatchObject({
      status: "streaming",
      approval: { status: "denied", consumedAt: expect.any(String) },
    });
    await waitForSettledMessageCount(session.id, 3);
    expect(runKyreiChat.mock.calls[1]?.[0].messages.at(-1)).toEqual({
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: APPROVAL_ID,
        approved: false,
        reason: "user_denied",
      }],
    });

    runKyreiChat.mockImplementationOnce(async (options: Record<string, any>) => {
      options.emit({ type: "message.complete", payload: { text: "Next turn accepted.", status: "complete" } });
      return { text: "Next turn accepted.", status: "complete", parts: [], responseMessages: [], attempts: [] };
    });
    await expect(request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Continue with another task" }),
    })).resolves.toMatchObject({ status: "streaming" });
    await waitFor(async () => runKyreiChat.mock.calls.length === 3);
  });

  it("fails an expired approval closed, consumes it, and accepts a later prompt", async () => {
    approvalExpiresAt = new Date(Date.now() - 60_000).toISOString();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Run only if approval is fresh" }),
    });
    await waitForPendingApproval(session.id);

    const response = await request<{ status: string; approval: Record<string, unknown> }>(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      { method: "POST", body: JSON.stringify({ approved: true }) },
    );
    expect(response).toMatchObject({
      status: "streaming",
      approval: {
        status: "expired",
        decisionReason: "approval_expired",
        consumedAt: expect.any(String),
      },
    });
    await waitForSettledMessageCount(session.id, 3);
    expect(runKyreiChat.mock.calls[1]?.[0].messages.at(-1)).toEqual({
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: APPROVAL_ID,
        approved: false,
        reason: "approval_expired",
      }],
    });

    runKyreiChat.mockImplementationOnce(async (options: Record<string, any>) => {
      options.emit({ type: "message.complete", payload: { text: "Fresh prompt accepted.", status: "complete" } });
      return { text: "Fresh prompt accepted.", status: "complete", parts: [], responseMessages: [], attempts: [] };
    });
    await expect(request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Start a fresh task" }),
    })).resolves.toMatchObject({ status: "streaming" });
    await waitFor(async () => runKyreiChat.mock.calls.length === 3);
  });

  it("preserves mixed approval responses while consuming only the safe decisions before effects", async () => {
    const secondApprovalId = "approval-87654321";
    const secondToolCallId = "call-approval-2";
    runKyreiChat.mockImplementationOnce(async (options: Record<string, any>) => {
      const approvals = [
        { approvalId: APPROVAL_ID, toolCallId: TOOL_CALL_ID, command: "npm test" },
        { approvalId: secondApprovalId, toolCallId: secondToolCallId, command: "npm run build" },
      ];
      for (const item of approvals) {
        options.emit({ type: "approval.request", payload: {
          approval_id: item.approvalId,
          tool_call_id: item.toolCallId,
          name: "run_command",
          args: { command: item.command },
          reason: "permission_rule_requires_confirmation",
        } });
      }
      options.emit({ type: "message.complete", payload: { text: "", status: "awaiting_approval" } });
      return {
        text: "",
        status: "awaiting_approval",
        parts: approvals.flatMap(item => [
          { type: "tool", toolCallId: item.toolCallId, name: "run_command", args: { command: item.command }, running: false },
          { type: "approval", approvalId: item.approvalId, toolCallId: item.toolCallId, name: "run_command", args: { command: item.command }, reason: "permission_rule_requires_confirmation", status: "pending" },
        ]),
        responseMessages: [{
          role: "assistant",
          content: approvals.flatMap(item => [
            { type: "tool-call", toolCallId: item.toolCallId, toolName: "run_command", input: { command: item.command } },
            { type: "tool-approval-request", approvalId: item.approvalId, toolCallId: item.toolCallId, signature: `signed-${item.approvalId}` },
          ]),
        }],
        attempts: [],
      };
    });

    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ session: session.id, text: "Run the safe subset" }),
    });
    await waitForPendingApproval(session.id);

    const first = await request<{ status: string; approval: Record<string, unknown> }>(
      `/api/sessions/${session.id}/approvals/${APPROVAL_ID}`,
      { method: "POST", body: JSON.stringify({ approved: false }) },
    );
    expect(first).toMatchObject({ status: "pending", approval: { status: "denied", consumedAt: expect.any(String) } });
    expect(runKyreiChat).toHaveBeenCalledTimes(1);

    runKyreiChat.mockImplementationOnce(async (options: Record<string, any>) => {
      const responses = options.messages.at(-1)?.content;
      expect(responses).toEqual(expect.arrayContaining([
        expect.objectContaining({ approvalId: APPROVAL_ID, approved: false }),
        expect.objectContaining({ approvalId: secondApprovalId, approved: true }),
      ]));
      await options.onApprovalConsumed(secondApprovalId, secondToolCallId);
      options.emit({ type: "approval.consumed", payload: { approval_id: secondApprovalId, tool_call_id: secondToolCallId } });
      options.emit({ type: "message.complete", payload: { text: "Safe subset completed.", status: "complete" } });
      return { text: "Safe subset completed.", status: "complete", parts: [], responseMessages: [], attempts: [] };
    });
    const second = await request<{ status: string }>(
      `/api/sessions/${session.id}/approvals/${secondApprovalId}`,
      { method: "POST", body: JSON.stringify({ approved: true }) },
    );
    expect(second.status).toBe("streaming");
    await waitForSettledMessageCount(session.id, 3);

    const stored = await request<{ messages: Array<Record<string, any>> }>(`/api/sessions/${session.id}/messages`);
    expect(stored.messages[1]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalId: APPROVAL_ID, status: "denied", consumedAt: expect.any(String) }),
      expect.objectContaining({ approvalId: secondApprovalId, status: "approved", consumedAt: expect.any(String) }),
    ]));
  });
});
