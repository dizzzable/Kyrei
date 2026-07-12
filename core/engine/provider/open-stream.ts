/**
 * Opens a streamText run with two fallbacks decided from its early stream parts:
 * 1. tool-unsupported (400/404/422) retries the same candidate without tools.
 * 2. retryable provider errors (429/5xx/network) try the next candidate.
 *
 * AI SDK 7 emits administrative `start` and `start-step` parts before an
 * early provider error, so probing must buffer that preamble rather than read
 * exactly one chunk. Every inspected part is replayed to the bridge.
 */

import { isRetryable, isToolUnsupported } from "./errors.js";

export interface StreamLike {
  stream: AsyncIterable<unknown>;
  responseMessages: PromiseLike<unknown[]>;
}

/** start(candidateIndex, useTools) returns a fresh streamText-like result. */
export type StartFn = (candidateIndex: number, useTools: boolean) => StreamLike;

interface Probe {
  values: unknown[];
  done: boolean;
  it: AsyncIterator<unknown>;
}

const MAX_PROBE_PARTS = 64;
const PREAMBLE_TYPES = new Set(["start", "start-step", "raw", "response-metadata"]);

function partType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as Record<string, unknown>)["type"];
  return typeof type === "string" ? type : undefined;
}

async function probe(s: StreamLike): Promise<Probe> {
  const it = s.stream[Symbol.asyncIterator]();
  const values: unknown[] = [];
  for (let i = 0; i < MAX_PROBE_PARTS; i++) {
    const next = await it.next();
    if (next.done) return { values, done: true, it };
    values.push(next.value);
    const type = partType(next.value);
    if (type === "error" || !type || !PREAMBLE_TYPES.has(type)) {
      return { values, done: false, it };
    }
  }
  return { values, done: false, it };
}

function isErrorPart(value: unknown): value is { type: "error"; error: unknown } {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["type"] === "error";
}

function replay(inspected: Probe): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* inspected.values;
      while (true) {
        const next = await inspected.it.next();
        if (next.done) break;
        yield next.value;
      }
    },
  };
}

function wrap(s: StreamLike, inspected: Probe): StreamLike {
  return { stream: replay(inspected), responseMessages: s.responseMessages };
}

function probeError(inspected: Probe): unknown | undefined {
  return inspected.values.find(isErrorPart)?.error;
}

export async function openStream(candidateCount: number, hasTools: boolean, start: StartFn): Promise<StreamLike> {
  let lastResort: StreamLike | null = null;

  for (let candidate = 0; candidate < candidateCount; candidate++) {
    const initial = start(candidate, hasTools);
    const inspected = await probe(initial);
    const error = probeError(inspected);

    if (error !== undefined) {
      if (hasTools && isToolUnsupported(error)) {
        const withoutTools = start(candidate, false);
        const inspectedWithoutTools = await probe(withoutTools);
        const errorWithoutTools = probeError(inspectedWithoutTools);
        if (errorWithoutTools === undefined) return wrap(withoutTools, inspectedWithoutTools);
        lastResort = wrap(withoutTools, inspectedWithoutTools);
        if (isRetryable(errorWithoutTools) && candidate < candidateCount - 1) continue;
        return lastResort;
      }

      if (isRetryable(error) && candidate < candidateCount - 1) {
        lastResort = wrap(initial, inspected);
        continue;
      }

      return wrap(initial, inspected);
    }

    return wrap(initial, inspected);
  }

  return lastResort ?? start(0, hasTools);
}
