import { describe, it, expect } from "vitest";
import { streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { bridgeStream, type BridgeCtx } from "./bridge.js";
import type { KyreiEvent } from "../types.js";
import type { ToolMeta } from "../tools/index.js";

function ctx(overrides: Partial<BridgeCtx> = {}): BridgeCtx {
  return { toolMeta: new Map<string, ToolMeta>(), provider: "mock", model: "mock", maxSteps: 12, ...overrides };
}

describe("stream-bridge (integration with MockLanguageModelV4)", () => {
  it("maps text-delta → message.delta and finish → complete", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "При" },
            { type: "text-delta", id: "t1", delta: "вет" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 2, text: 2, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });

    const events: KyreiEvent[] = [];
    const result = streamText({ model, prompt: "hi" });
    const out = await bridgeStream(result.stream, (e) => events.push(e), ctx());

    expect(out.text).toBe("Привет");
    expect(out.status).toBe("complete");
    expect(events.filter((e) => e.type === "message.delta")).toHaveLength(2);
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    const last = events.at(-1)!;
    expect(last.type).toBe("message.complete");
    if (last.type === "message.complete") {
      expect(last.payload.status).toBe("complete");
      expect(last.payload.text).toBe("Привет");
    }
  });
});

// Deterministic unit tests over synthetic stream parts.
async function* parts(list: unknown[]): AsyncIterable<unknown> {
  for (const p of list) yield p;
}

describe("stream-bridge (synthetic parts)", () => {
  it("preserves reasoning segment lifecycle with stable ids", async () => {
    const events: KyreiEvent[] = [];
    const result = await bridgeStream(
      parts([
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", text: "checking evidence" },
        { type: "reasoning-end", id: "r1" },
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]),
      (event) => events.push(event),
      ctx(),
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: "reasoning.start",
      payload: expect.objectContaining({ id: "r1", source: "provider" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "reasoning.delta",
      payload: expect.objectContaining({ id: "r1", text: "checking evidence" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "reasoning.complete",
      payload: expect.objectContaining({ id: "r1", state: "complete" }),
    }));
    expect(result.parts).toContainEqual(expect.objectContaining({
      type: "reasoning",
      id: "r1",
      text: "checking evidence",
      state: "complete",
    }));
  });

  it("normalizes V4 cache and reasoning usage into numeric context metrics", async () => {
    const out = await bridgeStream(
      parts([{
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: { total: 2_048, noCache: 512, cacheRead: 1_536, cacheWrite: undefined },
          outputTokens: { total: 1_024, text: 700, reasoning: 324 },
        },
      }]),
      () => undefined,
      ctx(),
    );

    expect(out.usage).toEqual({
      inputTokens: 2_048,
      outputTokens: 1_024,
      totalTokens: 3_072,
      cachedInputTokens: 1_536,
      reasoningTokens: 324,
    });
  });

  it("emits and persists a user approval request as an awaiting-approval turn", async () => {
    const events: KyreiEvent[] = [];
    const result = await bridgeStream(
      parts([
        { type: "start" },
        { type: "tool-call", toolCallId: "call-approval", toolName: "run_command", input: { command: "curl example.com" } },
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCall: { toolCallId: "call-approval", toolName: "run_command", input: { command: "curl example.com" } },
        },
        { type: "finish", finishReason: "tool-calls" },
      ]),
      (event) => events.push(event),
      ctx({
        approvalMeta: new Map([["call-approval", {
          reason: "permission_rule_requires_confirmation",
          args: { command: "curl example.com" },
        }]]),
      }),
    );

    expect(events).toContainEqual({
      type: "approval.request",
      payload: {
        approval_id: "approval-1",
        tool_call_id: "call-approval",
        name: "run_command",
        args: { command: "curl example.com" },
        reason: "permission_rule_requires_confirmation",
      },
    });
    expect(result.status).toBe("awaiting_approval");
    expect(result.parts).toContainEqual(expect.objectContaining({
      type: "approval",
      approvalId: "approval-1",
      toolCallId: "call-approval",
      status: "pending",
    }));
  });

  it("reconstructs a resumed approved tool when the continuation starts with its result", async () => {
    const events: KyreiEvent[] = [];
    const result = await bridgeStream(
      parts([
        { type: "tool-result", toolCallId: "call-approved", toolName: "run_command", output: "tests passed" },
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]),
      (event) => events.push(event),
      ctx({
        approvalMeta: new Map([["call-approved", {
          name: "run_command",
          reason: "permission_rule_requires_confirmation",
          args: { command: "npm test" },
        }]]),
      }),
    );

    expect(events.filter(event => event.type === "tool.start")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool.complete")).toHaveLength(1);
    expect(result.parts).toContainEqual(expect.objectContaining({
      type: "tool",
      toolCallId: "call-approved",
      result: "tests passed",
    }));
  });

  it("emits tool lifecycle with stable id, diff, and automatic snapshot metadata", async () => {
    const toolMeta = new Map<string, ToolMeta>([["call_1", { inlineDiff: "+new line", snapshotId: "snapshot-1" }]]);
    const events: KyreiEvent[] = [];
    const out = await bridgeStream(
      parts([
        { type: "start" },
        { type: "start-step" },
        { type: "tool-input-start", id: "call_1", toolName: "write_file" },
        { type: "tool-input-delta", id: "call_1", delta: '{"path":' },
        { type: "tool-call", toolCallId: "call_1", toolName: "write_file", input: { path: "a.txt" } },
        { type: "tool-result", toolCallId: "call_1", output: "Файл создан: a.txt" },
        { type: "text-delta", text: "готово" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
      ]),
      (e) => events.push(e),
      ctx({ toolMeta }),
    );

    const start = events.find((e) => e.type === "tool.start");
    const complete = events.find((e) => e.type === "tool.complete");
    expect(start && start.type === "tool.start" && start.payload.tool_call_id).toBe("call_1");
    expect(complete && complete.type === "tool.complete" && complete.payload.tool_call_id).toBe("call_1");
    if (complete?.type === "tool.complete") {
      expect(complete.payload.inline_diff).toBe("+new line");
      expect(complete.payload.snapshot_id).toBe("snapshot-1");
      expect(complete.payload.result).toBe("Файл создан: a.txt");
    }
    expect(out.parts).toContainEqual(expect.objectContaining({ snapshotId: "snapshot-1" }));
    expect(out.status).toBe("complete");
    expect(out.text).toBe("готово");
  });

  it("abort → interrupted, no error event (Property 4)", async () => {
    const events: KyreiEvent[] = [];
    const out = await bridgeStream(
      parts([
        { type: "text-delta", text: "частичный" },
        { type: "abort" },
      ]),
      (e) => events.push(e),
      ctx(),
    );
    expect(out.status).toBe("interrupted");
    expect(out.text).toBe("частичный");
    expect(events.some((e) => e.type === "error")).toBe(false);
    const last = events.at(-1)!;
    expect(last.type).toBe("message.complete");
    if (last.type === "message.complete") expect(last.payload.status).toBe("interrupted");
  });

  it("tool-error → tool.complete{error}, not a stream error", async () => {
    const events: KyreiEvent[] = [];
    const out = await bridgeStream(
      parts([
        { type: "tool-input-start", id: "c2", toolName: "run_command" },
        { type: "tool-call", toolCallId: "c2", toolName: "run_command", input: {} },
        { type: "tool-error", toolCallId: "c2", error: "boom" },
        { type: "finish", finishReason: "stop" },
      ]),
      (e) => events.push(e),
      ctx(),
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
    const complete = events.find((e) => e.type === "tool.complete");
    expect(complete?.type === "tool.complete" && complete.payload.error).toBe("boom");
    expect(out.status).toBe("complete");
  });

  it("reports a runtime guard stop as max_steps even after a normal stream finish", async () => {
    const out = await bridgeStream(
      parts([
        { type: "start-step" },
        { type: "tool-call", toolCallId: "repeat", toolName: "read_file", input: { path: "same.ts" } },
        { type: "tool-result", toolCallId: "repeat", output: "same" },
        { type: "finish", finishReason: "tool-calls" },
      ]),
      () => undefined,
      ctx({ guardStopReason: () => "repeated_tool_call" }),
    );

    expect(out.status).toBe("max_steps");
  });

  it("reports heal_handoff guard stop as heal_handoff status", async () => {
    const out = await bridgeStream(
      parts([
        { type: "start-step" },
        { type: "tool-error", toolCallId: "t1", toolName: "run_command", error: "fail" },
        { type: "finish", finishReason: "stop" },
      ]),
      () => undefined,
      ctx({ guardStopReason: () => "heal_handoff" }),
    );
    expect(out.status).toBe("heal_handoff");
  });
});
