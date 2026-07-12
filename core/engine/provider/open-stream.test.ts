import { describe, expect, it } from "vitest";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { openStream, type StreamLike } from "./open-stream.js";

function streamOf(parts: unknown[], messages: unknown[] = []): StreamLike {
  return {
    stream: (async function* () {
      for (const part of parts) yield part;
    })(),
    responseMessages: Promise.resolve(messages),
  };
}

describe("openStream adapter contract", () => {
  it("replays the inspected first part and preserves response messages", async () => {
    const messages = [{ role: "assistant", content: "done" }];
    const opened = await openStream(1, false, () =>
      streamOf([{ type: "start" }, { type: "text-delta", text: "done" }, { type: "finish" }], messages),
    );

    const seen: unknown[] = [];
    for await (const part of opened.stream) seen.push(part);

    expect(seen).toEqual([
      { type: "start" },
      { type: "text-delta", text: "done" },
      { type: "finish" },
    ]);
    await expect(opened.responseMessages).resolves.toEqual(messages);
  });

  it("detects an AI SDK 7 error after the start preamble and tries the next candidate", async () => {
    const candidates: number[] = [];
    const start = (candidate: number): StreamLike => {
      candidates.push(candidate);
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: candidate === 0
              ? [{ type: "error", error: { statusCode: 503, message: "unavailable" } }]
              : [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "ok" },
                  { type: "text-end", id: "t1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: undefined },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                      outputTokens: { total: 1, text: 1, reasoning: undefined },
                    },
                  },
                ],
          }),
        }),
      });
      const result = streamText({ model, prompt: "hi" });
      return { stream: result.stream, responseMessages: result.responseMessages };
    };

    const opened = await openStream(2, false, start);
    const types: string[] = [];
    for await (const part of opened.stream) {
      types.push(String((part as Record<string, unknown>)["type"]));
    }

    expect(candidates).toEqual([0, 1]);
    expect(types).toContain("text-delta");
    expect(types).not.toContain("error");
  });
});
