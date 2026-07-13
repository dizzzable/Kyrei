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
    expect(opened.candidateIndex).toBe(0);
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
    expect(opened.candidateIndex).toBe(1);
    expect(types).toContain("text-delta");
    expect(types).not.toContain("error");
  });

  it("keeps a tool-unsupported retry on the same candidate", async () => {
    const attempts: Array<{ candidate: number; useTools: boolean }> = [];
    const opened = await openStream(2, true, (candidate, useTools) => {
      attempts.push({ candidate, useTools });
      return useTools
        ? streamOf([{ type: "error", error: { statusCode: 400, message: "tools unsupported" } }])
        : streamOf([{ type: "text-delta", text: "ok" }]);
    });

    expect(attempts).toEqual([
      { candidate: 0, useTools: true },
      { candidate: 0, useTools: false },
    ]);
    expect(opened.candidateIndex).toBe(0);
  });

  it("tries the next candidate after a retryable synchronous start failure", async () => {
    const opened = await openStream(2, false, (candidate) => {
      if (candidate === 0) throw Object.assign(new Error("network unavailable"), { statusCode: 503 });
      return streamOf([{ type: "text-delta", text: "fallback" }]);
    });

    expect(opened.candidateIndex).toBe(1);
  });

  it("tries the next candidate when probing rejects before semantic output", async () => {
    const opened = await openStream(2, false, (candidate) => candidate === 0
      ? {
          stream: (async function* () { throw Object.assign(new Error("fetch failed"), { statusCode: 503 }); })(),
          responseMessages: Promise.reject(new Error("first failed")),
        }
      : streamOf([{ type: "text-delta", text: "fallback" }]));

    expect(opened.candidateIndex).toBe(1);
  });

  it("never changes providers for an abort", async () => {
    const abort = Object.assign(new Error("network request aborted"), { name: "AbortError" });
    let calls = 0;
    await expect(openStream(2, false, () => {
      calls += 1;
      throw abort;
    })).rejects.toBe(abort);
    expect(calls).toBe(1);
  });

  it("reports each early fallback attempt and releases its exact admission lease once", async () => {
    const acquired: number[] = [];
    const released: Array<{ handle: string; outcome: string; statusCode?: number; retryAfterMs?: number }> = [];
    const opened = await openStream(2, false, (candidate) => candidate === 0
      ? streamOf([{
          type: "error",
          error: { statusCode: 503, response: { headers: { "Retry-After": "2" } } },
        }])
      : streamOf([{ type: "text-delta", text: "fallback" }, { type: "finish" }]), {
      attemptLifecycle: {
        acquire(candidateIndex) {
          acquired.push(candidateIndex);
          return `lease-${candidateIndex}`;
        },
        release(handle, outcome) {
          released.push({
            handle: String(handle),
            outcome: outcome.outcome,
            ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
            ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
          });
        },
      },
    });

    for await (const _part of opened.stream) { /* drain */ }

    expect(acquired).toEqual([0, 1]);
    expect(opened.attempts).toEqual([
      { candidateIndex: 0, outcome: "retryable-error", phase: "probe", statusCode: 503, retryAfterMs: 2_000 },
      { candidateIndex: 1, outcome: "success", phase: "stream" },
    ]);
    expect(released).toEqual([
      { handle: "lease-0", outcome: "retryable-error", statusCode: 503, retryAfterMs: 2_000 },
      { handle: "lease-1", outcome: "success" },
    ]);
  });

  it("routes around an account-local auth failure before semantic output", async () => {
    const started: number[] = [];
    const released: Array<{ handle: string; outcome: string; statusCode?: number }> = [];
    const opened = await openStream(2, false, (candidate) => {
      started.push(candidate);
      return candidate === 0
        ? streamOf([{ type: "error", error: { statusCode: 401, message: "credential revoked" } }])
        : streamOf([{ type: "text-delta", text: "healthy account" }, { type: "finish" }]);
    }, {
      attemptLifecycle: {
        acquire: (candidate) => `lease-${candidate}`,
        release(handle, outcome) {
          released.push({
            handle: String(handle),
            outcome: outcome.outcome,
            ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
          });
        },
      },
    });

    const parts: unknown[] = [];
    for await (const part of opened.stream) parts.push(part);

    expect(started).toEqual([0, 1]);
    expect(opened.candidateIndex).toBe(1);
    expect(parts).toContainEqual({ type: "text-delta", text: "healthy account" });
    expect(opened.attempts).toEqual([
      { candidateIndex: 0, outcome: "terminal-error", phase: "probe", statusCode: 401 },
      { candidateIndex: 1, outcome: "success", phase: "stream" },
    ]);
    expect(released).toEqual([
      { handle: "lease-0", outcome: "terminal-error", statusCode: 401 },
      { handle: "lease-1", outcome: "success" },
    ]);
  });

  it("keeps a terminal error outcome when there is no safe fallback", async () => {
    const opened = await openStream(1, false, () => streamOf([
      { type: "start" },
      { type: "error", error: { statusCode: 401, message: "invalid credential" } },
    ]));
    const parts: unknown[] = [];
    for await (const part of opened.stream) parts.push(part);

    expect(parts).toHaveLength(2);
    expect(opened.attempts).toEqual([
      { candidateIndex: 0, outcome: "terminal-error", phase: "probe", statusCode: 401 },
    ]);
  });

  it("reacquires the same candidate for a no-tools retry", async () => {
    const acquired: number[] = [];
    const released: string[] = [];
    const opened = await openStream(1, true, (_candidate, useTools) => useTools
      ? streamOf([{ type: "error", error: { statusCode: 400, message: "tools unsupported" } }])
      : streamOf([{ type: "text-delta", text: "ok" }]), {
      attemptLifecycle: {
        acquire(candidateIndex) {
          acquired.push(candidateIndex);
          return `lease-${acquired.length}`;
        },
        release(handle) {
          released.push(String(handle));
        },
      },
    });
    for await (const _part of opened.stream) { /* drain */ }

    expect(acquired).toEqual([0, 0]);
    expect(released).toEqual(["lease-1", "lease-2"]);
    expect(opened.attempts?.map((attempt) => attempt.outcome)).toEqual(["tool-unsupported", "success"]);
  });

  it("skips a candidate whose just-in-time admission is at capacity", async () => {
    const started: number[] = [];
    const opened = await openStream(2, false, (candidate) => {
      started.push(candidate);
      return streamOf([{ type: "text-delta", text: "ok" }]);
    }, {
      attemptLifecycle: {
        acquire: (candidate) => candidate === 0 ? null : `lease-${candidate}`,
        release: () => {},
      },
    });
    for await (const _part of opened.stream) { /* drain */ }

    expect(started).toEqual([1]);
    expect(opened.attempts?.map((attempt) => attempt.outcome)).toEqual(["capacity-unavailable", "success"]);
  });
});
