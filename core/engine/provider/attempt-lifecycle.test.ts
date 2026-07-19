import { describe, expect, it, vi } from "vitest";

import { runWithProviderAttempt } from "./attempt-lifecycle.js";

describe("runWithProviderAttempt", () => {
  it("classifies a delegated idle timeout as retryable network failure", async () => {
    const handle = { lease: "worker-delegation-timeout" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    const timeout = Object.assign(new Error("Delegated research timed out after 1000ms"), {
      name: "TimeoutError",
      code: "delegation_timeout",
      timeoutMs: 1_000,
      reason: "idle",
    });

    await expect(runWithProviderAttempt(
      {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "delegate", modelId: "worker-model" },
      },
      async () => { throw timeout; },
    )).rejects.toBe(timeout);

    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "delegate",
      modelId: "worker-model",
      outcome: "retryable-error",
      phase: "stream",
      failureClass: "network",
    });
  });
});
