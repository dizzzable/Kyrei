import { describe, it, expect } from "vitest";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { buildModel } from "./build.js";
import {
  createToolCallIndexRemap,
  createToolCallIndexTransform,
  normalizeSseLine,
  withNormalizedToolCallIndexes,
} from "./tool-call-index.js";

/** Frames verbatim in shape from a gateway re-serving Anthropic over the OpenAI wire. */
const ANTHROPIC_STYLE_FRAMES = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: "I should call the tool." }, finish_reason: null }] },
  // The FIRST tool call arrives as index 1: the thinking block took block 0.
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 1,
          id: "toolu_01",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 1, type: "function", function: { arguments: "{\"city\": \"P" } }] },
      finish_reason: null,
    }],
  },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 1, type: "function", function: { arguments: "aris\"}" } }] },
      finish_reason: null,
    }],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
];

function sseBody(frames: unknown[], eol = "\n\n"): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}${eol}`).join("") + `data: [DONE]${eol}`;
}

function streamingResponse(body: string, chunkSize = 64): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.slice(at, at + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function readAll(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.reduce<Uint8Array>((all, part) => {
      const merged = new Uint8Array(all.length + part.length);
      merged.set(all);
      merged.set(part, all.length);
      return merged;
    }, new Uint8Array()),
  );
}

/** Collects the SDK stream parts a fixture produces, or the error it dies on. */
async function collectParts(
  fixture: string,
  options: { chunkSize?: number; useNormalizer?: boolean } = {},
): Promise<{ parts: Record<string, number>; toolInputs: string[]; thrown?: string }> {
  const raw: typeof fetch = async () => streamingResponse(fixture, options.chunkSize ?? 64);
  const provider = createOpenAICompatible({
    name: "kyrei",
    baseURL: "https://example.invalid/v1",
    apiKey: "test-key",
    includeUsage: true,
    fetch: options.useNormalizer === false ? raw : withNormalizedToolCallIndexes(raw),
  });

  const result = streamText({
    model: provider("test-model"),
    stopWhen: stepCountIs(1),
    tools: {
      get_weather: tool({
        description: "Get weather for a city",
        inputSchema: z.object({ city: z.string() }),
      }),
    },
    messages: [{ role: "user", content: "weather?" }],
    onError: () => {},
  });

  const parts: Record<string, number> = {};
  const toolInputs: string[] = [];
  try {
    for await (const part of result.fullStream) {
      parts[part.type] = (parts[part.type] ?? 0) + 1;
      if (part.type === "tool-call") toolInputs.push(JSON.stringify(part.input));
    }
  } catch (error) {
    return { parts, toolInputs, thrown: error instanceof Error ? error.message : String(error) };
  }
  return { parts, toolInputs };
}

describe("tool-call index normalization (non-conforming OpenAI-compatible gateways)", () => {
  it("reproduces the SDK crash when a gateway numbers the first tool call as index 1", async () => {
    const { thrown, toolInputs } = await collectParts(sseBody(ANTHROPIC_STYLE_FRAMES), { useNormalizer: false });

    // This is the failure the normalizer exists for. If a future SDK version
    // fixes it upstream this assertion flips, and the normalizer becomes a
    // no-op rather than a bug — so the test documents the reason it is here.
    expect(thrown).toBe("Cannot read properties of undefined (reading 'hasFinished')");
    expect(toolInputs).toEqual([]);
  });

  it("delivers the tool call intact once indices are renumbered", async () => {
    const { thrown, parts, toolInputs } = await collectParts(sseBody(ANTHROPIC_STYLE_FRAMES));

    expect(thrown).toBeUndefined();
    expect(toolInputs).toEqual(['{"city":"Paris"}']);
    expect(parts["tool-call"]).toBe(1);
    expect(parts["error"]).toBeUndefined();
    // The reasoning that occupied block 0 still arrives — the repair only
    // touches the tool-call numbering.
    expect(parts["reasoning-delta"]).toBe(1);
  });

  it("keeps parallel tool calls separate and preserves their argument fragments", async () => {
    const frames = [
      { choices: [{ index: 0, delta: { reasoning_content: "two calls" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "a", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{\"city\":\"Paris\"}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: "b", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: "{\"city\":" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: "\"Tokyo\"}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const { thrown, toolInputs } = await collectParts(sseBody(frames));

    expect(thrown).toBeUndefined();
    expect(toolInputs).toEqual(['{"city":"Paris"}', '{"city":"Tokyo"}']);
  });

  it("leaves a conforming stream byte-identical", async () => {
    const conforming = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = sseBody(conforming);

    const passed = await readAll(
      await withNormalizedToolCallIndexes(async () => streamingResponse(body))("https://example.invalid/v1/chat/completions"),
    );

    expect(passed).toBe(body);
  });

  it("renumbers correctly when a frame is split mid-JSON across network chunks", async () => {
    // 7 bytes at a time cuts every frame apart, including inside the numbers
    // being rewritten.
    const { thrown, toolInputs } = await collectParts(sseBody(ANTHROPIC_STYLE_FRAMES), { chunkSize: 7 });

    expect(thrown).toBeUndefined();
    expect(toolInputs).toEqual(['{"city":"Paris"}']);
  });

  it("passes CRLF frames through to the SSE parser", async () => {
    const { thrown, toolInputs } = await collectParts(sseBody(ANTHROPIC_STYLE_FRAMES, "\r\n\r\n"));

    expect(thrown).toBeUndefined();
    expect(toolInputs).toEqual(['{"city":"Paris"}']);
  });

  it("forwards non-SSE, error and bodiless responses untouched", async () => {
    const json = new Response('{"error":{"message":"nope"}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const failed = new Response("upstream is down", {
      status: 502,
      headers: { "content-type": "text/event-stream" },
    });
    const empty = new Response(null, { status: 204 });

    const normalize = (response: Response) =>
      withNormalizedToolCallIndexes(async () => response)("https://example.invalid/v1/chat/completions");

    expect(await normalize(json)).toBe(json);
    expect(await normalize(failed)).toBe(failed);
    expect(await normalize(empty)).toBe(empty);
  });

  it("fails open on frames it cannot interpret", () => {
    const remap = createToolCallIndexRemap();
    const untouched = [
      "data: [DONE]",
      "",
      ": keep-alive",
      "event: message",
      "data: not json at all",
      'data: {"choices":[{"delta":{"content":"tool_calls are only mentioned here"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"x","function":{"name":"f"}}]}}]}',
      'data: {"tool_calls":"top level, wrong shape"}',
      'data: {"choices":"tool_calls but choices is not an array"}',
    ];

    for (const line of untouched) {
      expect(normalizeSseLine(line, remap)).toBe(line);
    }
  });

  it("keeps each choice's tool-call numbering independent", () => {
    const remap = createToolCallIndexRemap();
    const line = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":3,"id":"a","function":{"name":"f"}}]}},'
      + '{"index":1,"delta":{"tool_calls":[{"index":5,"id":"b","function":{"name":"f"}}]}}]}';

    const rewritten = JSON.parse(normalizeSseLine(line, remap).slice("data: ".length));

    expect(rewritten.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(rewritten.choices[1].delta.tool_calls[0].index).toBe(0);
  });

  it("emits a stream that ends without a trailing newline", async () => {
    const transform = createToolCallIndexTransform();
    const body = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"id":"a","function":{"name":"f"}}]}}]}';
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });

    const out = await readAll(new Response(source.pipeThrough(transform)));

    expect(out.endsWith("\n")).toBe(false);
    expect(JSON.parse(out.slice("data: ".length)).choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("wires the normalizer into every openai-chat model buildModel returns", () => {
    const withoutFetch = buildModel({
      protocol: "openai-chat",
      baseURL: "https://krakenhub.xyz/v1",
      apiKey: "kh-test",
      model: "claude-opus-5",
    }) as unknown as { config: { fetch?: typeof fetch } };

    // The caller-supplied fetch is still honoured — it is wrapped, not replaced.
    const inner = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const withFetch = buildModel({
      protocol: "openai-chat",
      baseURL: "https://krakenhub.xyz/v1",
      apiKey: "kh-test",
      model: "claude-opus-5",
      fetch: inner,
    }) as unknown as { config: { fetch?: typeof fetch } };

    expect(typeof withoutFetch.config.fetch).toBe("function");
    expect(typeof withFetch.config.fetch).toBe("function");
    expect(withFetch.config.fetch).not.toBe(inner);
  });
});
