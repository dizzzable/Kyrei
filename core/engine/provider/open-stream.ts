/**
 * Opens a streamText run with two fallbacks handled via first-chunk peek
 * (streamText does NOT throw synchronously — errors surface inside fullStream):
 *   1. tool-unsupported (400/404/422 on tools) → retry the SAME candidate without tools.
 *   2. retryable provider error (429/5xx/network) → try the NEXT candidate.
 * Requirements §7.3, §7.5.
 */

import { isRetryable, isToolUnsupported } from "./errors.js";

export interface StreamLike {
  fullStream: AsyncIterable<unknown>;
  response: Promise<{ messages: unknown[] }>;
}

/** start(candidateIndex, useTools) → a fresh streamText-like result. */
export type StartFn = (candidateIndex: number, useTools: boolean) => StreamLike;

interface Head {
  value: unknown;
  done: boolean;
  it: AsyncIterator<unknown>;
}

async function peek(s: StreamLike): Promise<Head> {
  const it = s.fullStream[Symbol.asyncIterator]();
  const first = await it.next();
  return { value: first.value, done: Boolean(first.done), it };
}

function isErrorPart(v: unknown): v is { type: "error"; error: unknown } {
  return typeof v === "object" && v !== null && (v as Record<string, unknown>)["type"] === "error";
}

function replay(head: Head): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      if (!head.done) yield head.value;
      while (true) {
        const n = await head.it.next();
        if (n.done) break;
        yield n.value;
      }
    },
  };
}

function wrap(s: StreamLike, head: Head): StreamLike {
  return { fullStream: replay(head), response: s.response };
}

export async function openStream(candidateCount: number, hasTools: boolean, start: StartFn): Promise<StreamLike> {
  let lastResort: StreamLike | null = null;

  for (let c = 0; c < candidateCount; c++) {
    const s = start(c, hasTools);
    const head = await peek(s);

    if (isErrorPart(head.value)) {
      const err = head.value.error;

      // (1) tool-unsupported → retry same candidate without tools.
      if (hasTools && isToolUnsupported(err)) {
        const s2 = start(c, false);
        const head2 = await peek(s2);
        if (!isErrorPart(head2.value)) return wrap(s2, head2);
        lastResort = wrap(s2, head2);
        if (isRetryable(head2.value.error) && c < candidateCount - 1) continue;
        return lastResort;
      }

      // (2) retryable → try next candidate (if any).
      if (isRetryable(err) && c < candidateCount - 1) {
        lastResort = wrap(s, head);
        continue;
      }

      // Non-retryable error on the last (or only) candidate → surface it.
      return wrap(s, head);
    }

    // Healthy stream.
    return wrap(s, head);
  }

  return lastResort ?? start(0, hasTools);
}
