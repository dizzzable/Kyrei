import { describe, it, expect } from "vitest";
import { streamText, simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { bridgeStream, type BridgeCtx } from "./bridge.js";
import type { KyreiEvent } from "../types.js";
import type { ToolMeta } from "../tools/index.js";

function ctx(overrides: Partial<BridgeCtx> = {}): BridgeCtx {
  return { toolMeta: new Map<string, ToolMeta>(), provider: "mock", model: "mock", maxSteps: 12, ...overrides };
}

describe("stream-bridge (integration with MockLanguageModelV2)", () => {
  it("maps text-delta → message.delta and finish → complete", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "При" },
            { type: "text-delta", id: "t1", delta: "вет" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            },
          ],
        }),
      }),
    });

    const events: KyreiEvent[] = [];
    const result = streamText({ model, prompt: "hi" });
    const out = await bridgeStream(result.fullStream, (e) => events.push(e), ctx());

    expect(out.text).toBe("Привет");
    expect(out.status).toBe("complete");
    expect(events.filter((e) => e.type === "message.delta")).toHaveLength(2);
    const last = events.at(-1)!;
    expect(last.type).toBe("message.complete");
    if (last.type === "message.complete") {
      expect(last.payload.status).toBe("complete");
      expect(last.payload.text).toBe("Привет");
    }
  });
});

// Deterministic unit tests over synthetic fullStream parts.
async function* parts(list: unknown[]): AsyncIterable<unknown> {
  for (const p of list) yield p;
}

describe("stream-bridge (synthetic parts)", () => {
  it("emits tool lifecycle with stable id and inline_diff from toolMeta", async () => {
    const toolMeta = new Map<string, ToolMeta>([["call_1", { inlineDiff: "+new line" }]]);
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
      expect(complete.payload.result).toBe("Файл создан: a.txt");
    }
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
});
