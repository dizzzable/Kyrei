/**
 * Opens a streamText run with fallbacks decided only from early stream parts.
 * Every real provider attempt can be guarded by a synchronous admission lease;
 * the lease remains held until that exact attempt terminates.
 */

import { isAuthFailure, isRetryable, isToolUnsupported, retryAfterMsOf, statusOf } from "./errors.js";

export type ProviderStreamAttemptPhase = "start" | "probe" | "stream";
export type ProviderStreamAttemptOutcomeKind =
  | "capacity-unavailable"
  | "tool-unsupported"
  | "retryable-error"
  | "terminal-error"
  | "interrupted"
  | "success";

export interface ProviderStreamAttemptOutcome {
  candidateIndex: number;
  outcome: ProviderStreamAttemptOutcomeKind;
  phase: ProviderStreamAttemptPhase;
  statusCode?: number;
  retryAfterMs?: number;
}

export interface ProviderStreamAttemptLifecycle {
  acquire(candidateIndex: number): unknown | null;
  release(handle: unknown, outcome: ProviderStreamAttemptOutcome): void;
}

export interface OpenStreamOptions {
  attemptLifecycle?: ProviderStreamAttemptLifecycle;
}

export interface StreamLike {
  stream: AsyncIterable<unknown>;
  responseMessages: PromiseLike<unknown[]>;
  /** Candidate selected after the early error probe. Start functions may omit it. */
  candidateIndex?: number;
  /** Mutable only inside this module; complete after the returned stream terminates. */
  attempts?: ProviderStreamAttemptOutcome[];
}

/** start(candidateIndex, useTools) returns a fresh streamText-like result. */
export type StartFn = (candidateIndex: number, useTools: boolean) => StreamLike;

interface Probe {
  values: unknown[];
  done: boolean;
  it: AsyncIterator<unknown>;
}

interface ActiveAttempt {
  candidateIndex: number;
  handle: unknown;
  lifecycle?: ProviderStreamAttemptLifecycle;
  released: boolean;
}

interface OpenedAttempt {
  kind: "opened";
  stream: StreamLike;
  inspected: Probe;
  active: ActiveAttempt;
}

interface FailedAttempt {
  kind: "failed";
  error: unknown;
}

interface CapacityAttempt {
  kind: "capacity";
}

const MAX_PROBE_PARTS = 64;
const PREAMBLE_TYPES = new Set(["start", "start-step", "raw", "response-metadata"]);
const STREAM_ATTEMPTS_FIELD = "providerStreamAttempts";

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

function probeError(inspected: Probe): unknown | undefined {
  return inspected.values.find(isErrorPart)?.error;
}

function observeResponseMessages(stream: StreamLike): void {
  // A failed candidate is abandoned after the early probe. Attach a handler
  // immediately so its parallel response promise cannot become unhandled.
  void Promise.resolve(stream.responseMessages).catch(() => undefined);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return candidate["name"] === "AbortError" || candidate["code"] === "ABORT_ERR";
}

function outcomeForError(error: unknown): ProviderStreamAttemptOutcomeKind {
  if (isAbortError(error)) return "interrupted";
  return isRetryable(error) ? "retryable-error" : "terminal-error";
}

function attemptOutcome(
  candidateIndex: number,
  outcome: ProviderStreamAttemptOutcomeKind,
  phase: ProviderStreamAttemptPhase,
  error?: unknown,
): ProviderStreamAttemptOutcome {
  const statusCode = error === undefined ? undefined : statusOf(error);
  const retryAfterMs = error === undefined ? undefined : retryAfterMsOf(error);
  return {
    candidateIndex,
    outcome,
    phase,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function finishAttempt(
  active: ActiveAttempt,
  attempts: ProviderStreamAttemptOutcome[],
  outcome: ProviderStreamAttemptOutcome,
): void {
  if (active.released) return;
  active.released = true;
  attempts.push(outcome);
  active.lifecycle?.release(active.handle, outcome);
}

function attachStreamAttempts(error: unknown, attempts: ProviderStreamAttemptOutcome[]): never {
  let target: Error;
  if (error instanceof Error && Object.isExtensible(error)) {
    target = error;
  } else {
    const message = error instanceof Error ? error.message : "provider_stream_error";
    target = new Error(message, { cause: error });
    if (error instanceof Error) target.name = error.name;
  }
  Object.defineProperty(target, STREAM_ATTEMPTS_FIELD, {
    configurable: true,
    enumerable: false,
    value: attempts.map((attempt) => ({ ...attempt })),
  });
  throw target;
}

/** Read safe attempt telemetry from an error thrown before a stream was selected. */
export function streamAttemptsFromError(error: unknown): ProviderStreamAttemptOutcome[] {
  if (!error || typeof error !== "object") return [];
  const rows = (error as Record<string, unknown>)[STREAM_ATTEMPTS_FIELD];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const source = row as Record<string, unknown>;
    if (!Number.isInteger(source["candidateIndex"]) || !Number.isInteger(Number(source["candidateIndex"]))) return [];
    const candidateIndex = Number(source["candidateIndex"]);
    if (candidateIndex < 0) return [];
    const outcomes: ProviderStreamAttemptOutcomeKind[] = [
      "capacity-unavailable", "tool-unsupported", "retryable-error", "terminal-error", "interrupted", "success",
    ];
    const phases: ProviderStreamAttemptPhase[] = ["start", "probe", "stream"];
    if (!outcomes.includes(source["outcome"] as ProviderStreamAttemptOutcomeKind)) return [];
    if (!phases.includes(source["phase"] as ProviderStreamAttemptPhase)) return [];
    const statusCode = Number(source["statusCode"]);
    const retryAfterMs = Number(source["retryAfterMs"]);
    return [{
      candidateIndex,
      outcome: source["outcome"] as ProviderStreamAttemptOutcomeKind,
      phase: source["phase"] as ProviderStreamAttemptPhase,
      ...(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
      ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs: Math.floor(retryAfterMs) } : {}),
    }];
  });
}

function beginAttempt(
  candidateIndex: number,
  attempts: ProviderStreamAttemptOutcome[],
  lifecycle?: ProviderStreamAttemptLifecycle,
): ActiveAttempt | null {
  if (!lifecycle) return { candidateIndex, handle: undefined, released: false };
  const handle = lifecycle.acquire(candidateIndex);
  if (handle === null) {
    attempts.push(attemptOutcome(candidateIndex, "capacity-unavailable", "start"));
    return null;
  }
  return { candidateIndex, handle, lifecycle, released: false };
}

async function openAttempt(
  candidateIndex: number,
  useTools: boolean,
  start: StartFn,
  attempts: ProviderStreamAttemptOutcome[],
  lifecycle?: ProviderStreamAttemptLifecycle,
): Promise<OpenedAttempt | FailedAttempt | CapacityAttempt> {
  const active = beginAttempt(candidateIndex, attempts, lifecycle);
  if (!active) return { kind: "capacity" };

  let stream: StreamLike;
  try {
    stream = start(candidateIndex, useTools);
    observeResponseMessages(stream);
  } catch (error) {
    finishAttempt(active, attempts, attemptOutcome(candidateIndex, outcomeForError(error), "start", error));
    return { kind: "failed", error };
  }

  try {
    return { kind: "opened", stream, inspected: await probe(stream), active };
  } catch (error) {
    finishAttempt(active, attempts, attemptOutcome(candidateIndex, outcomeForError(error), "probe", error));
    return { kind: "failed", error };
  }
}

function replaySelected(
  inspected: Probe,
  active: ActiveAttempt,
  attempts: ProviderStreamAttemptOutcome[],
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      let completed = false;
      let observedError: unknown | undefined;
      let aborted = false;
      let thrown: unknown | undefined;
      try {
        for (const value of inspected.values) {
          if (isErrorPart(value)) observedError = value.error;
          if (partType(value) === "abort") aborted = true;
          yield value;
        }
        while (true) {
          const next = await inspected.it.next();
          if (next.done) break;
          if (isErrorPart(next.value)) observedError = next.value.error;
          if (partType(next.value) === "abort") aborted = true;
          yield next.value;
        }
        completed = true;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        const error = thrown ?? observedError;
        const outcome = aborted || (!completed && error === undefined)
          ? "interrupted"
          : error !== undefined
            ? outcomeForError(error)
            : "success";
        finishAttempt(active, attempts, attemptOutcome(active.candidateIndex, outcome, "stream", error));
      }
    },
  };
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

function wrap(
  stream: StreamLike,
  inspected: Probe,
  candidateIndex: number,
  attempts: ProviderStreamAttemptOutcome[],
  active?: ActiveAttempt,
): StreamLike {
  return {
    stream: active ? replaySelected(inspected, active, attempts) : replay(inspected),
    responseMessages: stream.responseMessages,
    candidateIndex,
    attempts,
  };
}

function capacityError(attempts: ProviderStreamAttemptOutcome[]): never {
  const error = Object.assign(new Error("provider_capacity_unavailable"), { code: "provider_capacity_unavailable" });
  return attachStreamAttempts(error, attempts);
}

function canTryNextCandidate(error: unknown, candidate: number, candidateCount: number): boolean {
  return !isAbortError(error)
    && (isRetryable(error) || isAuthFailure(error))
    && candidate < candidateCount - 1;
}

export async function openStream(
  candidateCount: number,
  hasTools: boolean,
  start: StartFn,
  options: OpenStreamOptions = {},
): Promise<StreamLike> {
  const attempts: ProviderStreamAttemptOutcome[] = [];

  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const initial = await openAttempt(candidate, hasTools, start, attempts, options.attemptLifecycle);
    if (initial.kind === "capacity") continue;
    if (initial.kind === "failed") {
      if (canTryNextCandidate(initial.error, candidate, candidateCount)) continue;
      return attachStreamAttempts(initial.error, attempts);
    }
    const error = probeError(initial.inspected);

    if (error !== undefined) {
      if (hasTools && isToolUnsupported(error)) {
        finishAttempt(initial.active, attempts, attemptOutcome(candidate, "tool-unsupported", "probe", error));
        const withoutTools = await openAttempt(candidate, false, start, attempts, options.attemptLifecycle);
        if (withoutTools.kind === "capacity") continue;
        if (withoutTools.kind === "failed") {
          if (canTryNextCandidate(withoutTools.error, candidate, candidateCount)) continue;
          return attachStreamAttempts(withoutTools.error, attempts);
        }
        const errorWithoutTools = probeError(withoutTools.inspected);
        if (errorWithoutTools === undefined) {
          return wrap(withoutTools.stream, withoutTools.inspected, candidate, attempts, withoutTools.active);
        }
        finishAttempt(
          withoutTools.active,
          attempts,
          attemptOutcome(candidate, outcomeForError(errorWithoutTools), "probe", errorWithoutTools),
        );
        if (canTryNextCandidate(errorWithoutTools, candidate, candidateCount)) continue;
        return wrap(withoutTools.stream, withoutTools.inspected, candidate, attempts);
      }

      finishAttempt(initial.active, attempts, attemptOutcome(candidate, outcomeForError(error), "probe", error));
      if (canTryNextCandidate(error, candidate, candidateCount)) continue;
      return wrap(initial.stream, initial.inspected, candidate, attempts);
    }

    return wrap(initial.stream, initial.inspected, candidate, attempts, initial.active);
  }

  return capacityError(attempts);
}
