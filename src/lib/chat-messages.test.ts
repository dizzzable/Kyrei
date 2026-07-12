import { describe, expect, it } from "vitest";
import { appendReasoning, appendText, messageText, toolComplete, toolStart } from "@/lib/chat-messages";
import type { MessagePart, ToolPart } from "@/lib/types";

const tools = (parts: MessagePart[]): ToolPart[] => parts.filter((p): p is ToolPart => p.type === "tool");

describe("appendText / appendReasoning coalescing", () => {
  it("coalesces consecutive text deltas into a single text part", () => {
    let parts: MessagePart[] = [];
    parts = appendText(parts, "Hello");
    parts = appendText(parts, ", world");

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: "text", text: "Hello, world" });
    expect(messageText(parts)).toBe("Hello, world");
  });

  it("does not create a third text part when reasoning interleaves two text deltas", () => {
    let parts: MessagePart[] = [];
    parts = appendText(parts, "The answer ");
    parts = appendReasoning(parts, "thinking...");
    parts = appendText(parts, "is 42");

    // Reasoning is transparent within the segment: the second text delta lands
    // on the existing text part instead of opening a new one.
    const textParts = parts.filter(p => p.type === "text");
    const reasoningParts = parts.filter(p => p.type === "reasoning");
    expect(textParts).toHaveLength(1);
    expect(reasoningParts).toHaveLength(1);
    expect(messageText(parts)).toBe("The answer is 42");
  });

  it("opens a fresh text segment after a tool part", () => {
    let parts: MessagePart[] = [];
    parts = appendText(parts, "before");
    parts = toolStart(parts, { toolCallId: "t1", name: "read" });
    parts = toolComplete(parts, { toolCallId: "t1", result: "ok" });
    parts = appendText(parts, "after");

    const textParts = parts.filter(p => p.type === "text");
    expect(textParts).toHaveLength(2);
    expect(textParts.map(p => (p as { text: string }).text)).toEqual(["before", "after"]);
  });
});

describe("toolStart / toolComplete matching", () => {
  it("updates the same part on complete for a matching id (no duplicate)", () => {
    let parts: MessagePart[] = [];
    parts = toolStart(parts, { toolCallId: "call-1", name: "read", args: { path: "a.ts" } });
    parts = toolComplete(parts, { toolCallId: "call-1", result: "done", durationS: 1.5 });

    expect(tools(parts)).toHaveLength(1);
    const [tool] = tools(parts);
    expect(tool.toolCallId).toBe("call-1");
    expect(tool.running).toBe(false);
    expect(tool.result).toBe("done");
    expect(tool.durationS).toBe(1.5);
    expect(tool.args).toEqual({ path: "a.ts" });
  });

  it("keeps two parallel starts with distinct ids as separate parts", () => {
    let parts: MessagePart[] = [];
    parts = toolStart(parts, { toolCallId: "a", name: "read" });
    parts = toolStart(parts, { toolCallId: "b", name: "read" });

    expect(tools(parts)).toHaveLength(2);
    expect(tools(parts).map(t => t.toolCallId)).toEqual(["a", "b"]);
  });

  it("does not duplicate on a repeated start with the same id", () => {
    let parts: MessagePart[] = [];
    parts = toolStart(parts, { toolCallId: "dup", name: "read" });
    parts = toolStart(parts, { toolCallId: "dup", name: "read", args: { path: "x" } });

    expect(tools(parts)).toHaveLength(1);
    expect(tools(parts)[0].args).toEqual({ path: "x" });
  });

  it("matches a completion without id to the pending same-name part", () => {
    let parts: MessagePart[] = [];
    parts = toolStart(parts, { toolCallId: "t9", name: "grep" });
    parts = toolComplete(parts, { name: "grep", result: "found" });

    expect(tools(parts)).toHaveLength(1);
    expect(tools(parts)[0].result).toBe("found");
    expect(tools(parts)[0].running).toBe(false);
  });

  it("resolves two parallel completions to their respective pending parts", () => {
    let parts: MessagePart[] = [];
    parts = toolStart(parts, { toolCallId: "a", name: "read" });
    parts = toolStart(parts, { toolCallId: "b", name: "read" });
    parts = toolComplete(parts, { toolCallId: "a", result: "ra" });
    parts = toolComplete(parts, { toolCallId: "b", result: "rb" });

    const t = tools(parts);
    expect(t).toHaveLength(2);
    expect(t.find(x => x.toolCallId === "a")?.result).toBe("ra");
    expect(t.find(x => x.toolCallId === "b")?.result).toBe("rb");
    expect(t.every(x => x.running === false)).toBe(true);
  });

  it("records an error on completion", () => {
    let parts: MessagePart[] = [];
    parts = toolStart(parts, { toolCallId: "e1", name: "write" });
    parts = toolComplete(parts, { toolCallId: "e1", error: "boom" });

    expect(tools(parts)[0].error).toBe("boom");
    expect(tools(parts)[0].running).toBe(false);
  });

  it("ignores a completion that matches nothing", () => {
    const parts: MessagePart[] = [{ type: "text", text: "hi" }];
    const next = toolComplete(parts, { toolCallId: "missing", result: "x" });
    expect(next).toBe(parts);
  });
});
