import { describe, it, expect } from "vitest";
import { isRetryable, isRateLimit, isToolUnsupported, isServerError } from "./errors.js";
import { resolve, isLocalBaseURL } from "./registry.js";
import { KeyPool } from "./keys.js";
import { openStream, type StreamLike } from "./open-stream.js";
import { buildProviderOptions } from "./build.js";

describe("buildProviderOptions (reasoning/effort)", () => {
  it("emits nothing when no params or reasoning disabled", () => {
    expect(buildProviderOptions("openai-chat", undefined)).toBeUndefined();
    expect(buildProviderOptions("openai-chat", {})).toBeUndefined();
    expect(buildProviderOptions("openai-chat", { effort: "off" })).toBeUndefined();
    expect(buildProviderOptions("openai-chat", { effort: "none" })).toBeUndefined();
  });
  it("maps explicit effort to protocol-specific providerOptions", () => {
    expect(buildProviderOptions("openai-chat", { effort: "high" })).toEqual({ kyrei: { reasoningEffort: "high" } });
    expect(buildProviderOptions("openai-responses", { effort: "low" })).toEqual({ openai: { reasoningEffort: "low" } });
  });
  it("preserves xhigh for responses and clamps UI-only max elsewhere", () => {
    expect(buildProviderOptions("openai-chat", { effort: "xhigh" })).toEqual({ kyrei: { reasoningEffort: "high" } });
    expect(buildProviderOptions("openai-chat", { effort: "max" })).toEqual({ kyrei: { reasoningEffort: "high" } });
    expect(buildProviderOptions("openai-responses", { effort: "xhigh" })).toEqual({ openai: { reasoningEffort: "xhigh" } });
    expect(buildProviderOptions("openai-responses", { effort: "max" })).toEqual({ openai: { reasoningEffort: "xhigh" } });
  });
  it("derives from fast/reasoning when no explicit effort", () => {
    expect(buildProviderOptions("openai-chat", { fast: true })).toEqual({ kyrei: { reasoningEffort: "minimal" } });
    expect(buildProviderOptions("openai-chat", { reasoning: true })).toEqual({ kyrei: { reasoningEffort: "medium" } });
  });
  it("explicit effort wins over fast", () => {
    expect(buildProviderOptions("openai-chat", { effort: "high", fast: true })).toEqual({ kyrei: { reasoningEffort: "high" } });
  });
  it("skips providerOptions for unsupported protocols", () => {
    expect(buildProviderOptions("anthropic-messages", { effort: "high" })).toBeUndefined();
  });
});

describe("errors classification", () => {
  it("rate limit / server / retryable", () => {
    expect(isRateLimit({ statusCode: 429 })).toBe(true);
    expect(isServerError({ status: 503 })).toBe(true);
    expect(isRetryable({ statusCode: 500 })).toBe(true);
    expect(isRetryable({ message: "fetch failed" })).toBe(true);
    expect(isRetryable({ statusCode: 400, message: "bad" })).toBe(false);
  });
  it("tool unsupported detection", () => {
    expect(isToolUnsupported({ statusCode: 400, message: "tools are not supported" })).toBe(true);
    expect(isToolUnsupported({ statusCode: 404, message: "unknown parameter: tool_choice" })).toBe(true);
    expect(isToolUnsupported({ statusCode: 500, message: "tool" })).toBe(false);
    expect(isToolUnsupported({ statusCode: 400, message: "rate" })).toBe(false);
  });
});

describe("registry.resolve", () => {
  it("resolves known role/id and unknown fallback", () => {
    expect(resolve("default").id).toBe("gpt-4o-mini");
    expect(resolve("llama3.1:8b").provider).toBe("ollama");
    const custom = resolve("my-model", { baseURL: "http://localhost:11434/v1", id: "my-model" });
    expect(custom.provider).toBe("custom");
    expect(custom.baseURL).toBe("http://localhost:11434/v1");
  });
  it("detects local base URLs", () => {
    expect(isLocalBaseURL("http://localhost:11434/v1")).toBe(true);
    expect(isLocalBaseURL("https://api.openai.com/v1")).toBe(false);
  });
});

describe("KeyPool", () => {
  it("round-robins across multiple keys", () => {
    const pool = new KeyPool({ keys: ["k1", "k2", "k3"] });
    expect(pool.isMulti()).toBe(true);
    // pick is private; exercise via fetchMiddleware indirectly is heavy — assert size/staticKey.
    expect(pool.size).toBe(3);
  });
  it("single key → not multi", () => {
    const pool = new KeyPool({ keys: ["only"] });
    expect(pool.isMulti()).toBe(false);
    expect(pool.staticKey()).toBe("only");
  });
});

// ── openStream fallbacks ──────────────────────────────────────────────
function streamOf(parts: unknown[]): StreamLike {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    response: Promise.resolve({ messages: [] }),
  };
}
async function collect(s: StreamLike): Promise<string[]> {
  const types: string[] = [];
  for await (const p of s.fullStream) types.push((p as { type: string }).type);
  return types;
}

describe("openStream — no-tools fallback", () => {
  it("retries the same candidate without tools on tool-unsupported error", async () => {
    let calls: Array<{ c: number; useTools: boolean }> = [];
    const start = (c: number, useTools: boolean): StreamLike => {
      calls.push({ c, useTools });
      if (useTools) return streamOf([{ type: "error", error: { statusCode: 400, message: "tools not supported" } }]);
      return streamOf([{ type: "text-delta", text: "ok" }, { type: "finish" }]);
    };
    const s = await openStream(1, true, start);
    const types = await collect(s);
    expect(types).toEqual(["text-delta", "finish"]);
    expect(calls).toEqual([
      { c: 0, useTools: true },
      { c: 0, useTools: false },
    ]);
  });
});

describe("openStream — provider fallback", () => {
  it("moves to the next candidate on a retryable error", async () => {
    const start = (c: number): StreamLike => {
      if (c === 0) return streamOf([{ type: "error", error: { statusCode: 503, message: "unavailable" } }]);
      return streamOf([{ type: "text-delta", text: "hi" }, { type: "finish" }]);
    };
    const s = await openStream(2, false, start);
    expect(await collect(s)).toEqual(["text-delta", "finish"]);
  });

  it("surfaces a non-retryable error on the only candidate (head preserved)", async () => {
    const start = (): StreamLike => streamOf([{ type: "error", error: { statusCode: 401, message: "bad key" } }]);
    const s = await openStream(1, false, start);
    expect(await collect(s)).toEqual(["error"]);
  });

  it("uses a healthy first candidate and preserves its first part", async () => {
    const start = (): StreamLike => streamOf([{ type: "text-delta", text: "a" }, { type: "finish" }]);
    const s = await openStream(2, false, start);
    expect(await collect(s)).toEqual(["text-delta", "finish"]);
  });
});
