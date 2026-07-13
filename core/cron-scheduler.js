import { nextCronRun } from "./cron-store.js";

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Minute-resolution cron runner with an injectable clock and timer surface.
 * A scheduled run is claimed durably before invoking `runJob`, so repeated
 * ticks (and restarts in the same minute) cannot fire it twice.
 */
export class CronScheduler {
  constructor({
    store,
    runJob,
    now = () => new Date(),
    intervalMs = DEFAULT_INTERVAL_MS,
    setInterval: setIntervalImpl = globalThis.setInterval,
    clearInterval: clearIntervalImpl = globalThis.clearInterval,
  } = {}) {
    if (!store || typeof store.list !== "function" || typeof store.beginRun !== "function") {
      throw new TypeError("cron-store-required");
    }
    if (typeof runJob !== "function") throw new TypeError("cron-runner-required");
    if (typeof now !== "function") throw new TypeError("cron-clock-required");
    if (!Number.isInteger(intervalMs) || intervalMs < 100) throw new RangeError("cron-interval-invalid");
    if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
      throw new TypeError("cron-timer-required");
    }

    this.store = store;
    this.runJob = runJob;
    this.now = now;
    this.intervalMs = intervalMs;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.timer = null;
    this.tickPromise = null;
    this.inFlightByJob = new Map();
    this.stopping = false;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer !== null) return this;
    this.stopping = false;
    void this.tick().catch(() => {});
    this.timer = this.setInterval(() => {
      void this.tick().catch(() => {});
    }, this.intervalMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return this;
  }

  async stop() {
    this.stopping = true;
    if (this.timer !== null) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    // All executions finish through CronStore.finishRun, whose promise only
    // resolves after the atomic state write. Waiting here therefore gives the
    // gateway a clean persistence boundary during shutdown.
    const pending = new Set([
      ...(this.tickPromise ? [this.tickPromise] : []),
      ...this.inFlightByJob.values(),
    ]);
    await Promise.allSettled(pending);
  }

  /** Run all jobs due at the supplied/current minute, once. */
  async tick(at = this.now()) {
    if (this.stopping) return [];
    if (this.tickPromise) return this.tickPromise;
    const operation = this.runTick(toDate(at, "cron-clock-invalid"));
    this.tickPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.tickPromise === operation) this.tickPromise = null;
    }
  }

  /** Trigger a job immediately, even while it is paused. */
  async trigger(id) {
    const job = this.store.get(id);
    if (!job) throw notFound("cron-job-not-found");
    return this.execute(job, { trigger: "manual", now: toDate(this.now(), "cron-clock-invalid") });
  }

  async runTick(now) {
    const minute = floorToMinute(now);
    const dueJobs = this.store.list().filter(job => (
      job.enabled
      && typeof job.nextRunAt === "string"
      && Number.isFinite(Date.parse(job.nextRunAt))
      && Date.parse(job.nextRunAt) <= minute.getTime()
    ));
    const results = await Promise.all(dueJobs.map(job => this.execute(job, {
      trigger: "scheduled",
      now,
      scheduledFor: minute,
      dueAt: job.nextRunAt,
    })));
    return results.filter(Boolean);
  }

  execute(job, context) {
    if (this.stopping || this.inFlightByJob.has(job.id)) return Promise.resolve(null);
    const operation = this.executeClaimed(job, context);
    this.inFlightByJob.set(job.id, operation);
    return operation.finally(() => {
      if (this.inFlightByJob.get(job.id) === operation) this.inFlightByJob.delete(job.id);
    });
  }

  async executeClaimed(job, context) {
    const scheduled = context.trigger === "scheduled";
    const run = await this.store.beginRun(job.id, {
      trigger: context.trigger,
      ...(scheduled ? {
        scheduledFor: context.scheduledFor,
        dueAt: context.dueAt,
        // Advance from the current slot, not a stale due time. This skips a
        // catch-up storm after downtime while retaining one run for the slot.
        nextFrom: context.scheduledFor,
      } : {}),
    });
    if (!run) return null;
    // stop() may have begun while the durable claim was being written. Do not
    // start user work after that shutdown boundary; close the claimed record
    // as cancelled so stop() can await a consistent persisted outcome.
    if (this.stopping) {
      return this.store.finishRun(job.id, run.id, {
        status: "cancelled",
        error: "cron-run-interrupted",
      });
    }

    const currentJob = this.store.get(job.id) ?? job;
    const callbackContext = {
      trigger: context.trigger,
      runId: run.id,
      scheduledFor: run.scheduledFor,
      dueAt: run.dueAt,
    };
    try {
      const result = await this.runJob(currentJob, callbackContext);
      const resultStatus = result && typeof result === "object" ? result.status : undefined;
      if (resultStatus === "cancelled" || resultStatus === "interrupted") {
        return this.store.finishRun(job.id, run.id, {
          status: "cancelled",
          error: result.error ?? result.message,
          sessionId: result.sessionId ?? result.session_id,
          result: result.result ?? result.summary,
        });
      }
      if (resultStatus === "error" || resultStatus === "failed") {
        return this.store.finishRun(job.id, run.id, {
          status: "error",
          error: result.error ?? result.message ?? "cron-run-failed",
          sessionId: result.sessionId ?? result.session_id,
          result: result.result ?? result.summary,
        });
      }
      return this.store.finishRun(job.id, run.id, {
        status: "success",
        sessionId: result && typeof result === "object" ? result.sessionId ?? result.session_id : undefined,
        result: summarizeResult(result),
      });
    } catch (error) {
      return this.store.finishRun(job.id, run.id, {
        status: isCancellation(error) ? "cancelled" : "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Convenience helper for integrations that only need the next ISO timestamp. */
export function nextCronRunAt(expression, from) {
  return nextCronRun(expression, from).toISOString();
}

function summarizeResult(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.summary ?? value.result ?? undefined;
  return String(value);
}

function isCancellation(error) {
  if (error?.name === "AbortError") return true;
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  if (code === "abort_err" || code === "cancelled" || code === "canceled") return true;
  return /\b(?:abort(?:ed)?|cancelled|canceled|interrupted)\b/i.test(String(error?.message ?? ""));
}

function floorToMinute(value) {
  const date = toDate(value, "cron-minute-invalid");
  date.setSeconds(0, 0);
  return date;
}

function toDate(value, code) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(code);
  return date;
}

function notFound(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
