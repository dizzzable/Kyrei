/**
 * Small stateful health gate shared by local optional runtimes.
 *
 * It coalesces concurrent probes, retains a last-good snapshot through one
 * transient failure, and exposes stable metadata without hiding a sustained
 * outage. The caller owns transport-specific probing and result shapes.
 */
export class RuntimeHealthGate {
  constructor({
    cacheTtlMs = 2_000,
    failureThreshold = 2,
    retryDelayMs = 5_000,
    classify = (value) => value?.state === "ready" ? "healthy" : "failure",
    now = () => Date.now(),
  } = {}) {
    if (typeof classify !== "function" || typeof now !== "function") throw new TypeError("runtime_health_options_invalid");
    this.cacheTtlMs = boundedInteger(cacheTtlMs, 0, 60_000, 2_000);
    this.failureThreshold = boundedInteger(failureThreshold, 1, 20, 2);
    this.retryDelayMs = boundedInteger(retryDelayMs, 0, 3_600_000, 5_000);
    this.classify = classify;
    this.now = now;
    this.entries = new Map();
  }

  async probe(key, operation, { force = false } = {}) {
    if (typeof key !== "string" || !key || typeof operation !== "function") {
      throw new TypeError("runtime_health_probe_invalid");
    }
    const current = this.entries.get(key) ?? freshEntry();
    const timestamp = this.now();
    if (!force && current.value && timestamp - current.probedAt < this.cacheTtlMs) return current.value;
    if (current.inFlight) return current.inFlight;

    const inFlight = Promise.resolve()
      .then(operation)
      .then((value) => this.#observe(key, value))
      .finally(() => {
        const latest = this.entries.get(key);
        if (latest?.inFlight === inFlight) latest.inFlight = null;
      });
    current.inFlight = inFlight;
    this.entries.set(key, current);
    return inFlight;
  }

  reset(key) {
    if (typeof key === "string" && key) this.entries.delete(key);
    else this.entries.clear();
  }

  #observe(key, observed) {
    const current = this.entries.get(key) ?? freshEntry();
    const timestamp = this.now();
    const classification = this.classify(observed);
    let value;

    if (classification === "healthy") {
      value = observed;
      current.lastGood = observed;
      current.lastGoodAt = timestamp;
      current.failures = 0;
    } else if (classification === "failure") {
      current.failures += 1;
      const detail = failureDetail(observed);
      if (current.lastGood && current.failures < this.failureThreshold) {
        value = {
          ...current.lastGood,
          degraded: true,
          stale: true,
          consecutiveFailures: current.failures,
          healthReason: detail,
          lastGoodAt: new Date(current.lastGoodAt).toISOString(),
          nextRetryAt: new Date(timestamp + this.retryDelayMs).toISOString(),
        };
      } else if (current.lastGood) {
        value = {
          ...observed,
          degraded: true,
          stale: Boolean(current.lastGood),
          consecutiveFailures: current.failures,
          ...(detail ? { healthReason: detail } : {}),
          ...(current.lastGoodAt ? { lastGoodAt: new Date(current.lastGoodAt).toISOString() } : {}),
          nextRetryAt: new Date(timestamp + this.retryDelayMs).toISOString(),
        };
      } else {
        // Preserve the established response shape on first probe. Hysteresis
        // metadata becomes meaningful only after there is a last-good value
        // to retain or a repeated outage to report.
        value = observed;
      }
    } else {
      current.failures = 0;
      value = observed;
    }

    current.value = value;
    current.probedAt = timestamp;
    this.entries.set(key, current);
    return value;
  }
}

function freshEntry() {
  return { value: null, probedAt: 0, inFlight: null, failures: 0, lastGood: null, lastGoodAt: 0 };
}

function boundedInteger(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function failureDetail(value) {
  for (const candidate of [value?.reason, value?.message, value?.error, value?.state]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 200);
  }
  return "health_probe_failed";
}
