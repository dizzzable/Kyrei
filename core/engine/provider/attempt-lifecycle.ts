import type {
  ProviderAttemptLifecycle,
  ProviderAttemptOutcome,
  ProviderAttemptTarget,
} from "../types.js";
import { classifyProviderFailure, isRetryable, retryAfterMsOf, statusOf } from "./errors.js";

/** One private provider identity bound to the gateway-owned admission hook. */
export interface ProviderAttemptBinding {
  lifecycle: ProviderAttemptLifecycle;
  target: ProviderAttemptTarget;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const source = error as Record<string, unknown>;
  return source["name"] === "AbortError" || source["code"] === "ABORT_ERR";
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message = reason instanceof Error && reason.message
    ? reason.message
    : "provider_attempt_interrupted";
  const error = new Error(message, { cause: reason });
  error.name = "AbortError";
  return error;
}

function capacityError(): Error & { code: string } {
  return Object.assign(new Error("provider_capacity_unavailable"), {
    code: "provider_capacity_unavailable",
  });
}

/** Some providers surface a terminal generation failure as a resolved result. */
export function assertProviderGenerationSucceeded<T>(result: T): T {
  if (
    result
    && typeof result === "object"
    && (result as Record<string, unknown>)["finishReason"] === "error"
  ) {
    throw Object.assign(new Error("provider_generation_error"), {
      code: "provider_generation_error",
    });
  }
  return result;
}

function failedOutcome(
  target: ProviderAttemptTarget,
  error: unknown,
  interrupted: boolean,
): ProviderAttemptOutcome {
  const statusCode = statusOf(error);
  const retryAfterMs = retryAfterMsOf(error);
  const interruptedOutcome = interrupted || isAbortError(error);
  return {
    ...target,
    outcome: interruptedOutcome
      ? "interrupted"
      : isRetryable(error)
        ? "retryable-error"
        : "terminal-error",
    phase: "stream",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    // Interrupted aborts must not train the account pool (user cancel / session stop).
    ...(!interruptedOutcome ? { failureClass: classifyProviderFailure(error) } : {}),
  };
}

/**
 * Guard one real auxiliary model invocation with a just-in-time account lease.
 * A non-null handle is released exactly once, including provider failures and
 * cancellation. Capacity rejection happens before the provider is called.
 */
export async function runWithProviderAttempt<T>(
  binding: ProviderAttemptBinding | undefined,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal);
  if (!binding) return operation();

  const handle = binding.lifecycle.acquire(binding.target);
  if (handle === null) throw capacityError();

  let value!: T;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  const interrupted = !operationFailed && signal?.aborted === true;
  const outcome: ProviderAttemptOutcome = operationFailed
    ? failedOutcome(binding.target, operationFailure, signal?.aborted === true)
    : interrupted
      ? { ...binding.target, outcome: "interrupted", phase: "stream" }
      : { ...binding.target, outcome: "success", phase: "stream" };
  let releaseFailed = false;
  let releaseFailure: unknown;
  try {
    binding.lifecycle.release(handle, outcome);
  } catch (error) {
    releaseFailed = true;
    releaseFailure = error;
  }

  // A provider failure is more useful than a secondary accounting failure.
  if (operationFailed) throw operationFailure;
  if (interrupted) throw abortError(signal!);
  if (releaseFailed) throw releaseFailure;
  return value;
}
