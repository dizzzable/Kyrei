import { describe, expect, it, vi } from "vitest";

import { runWithProviderAttempt } from "./attempt-lifecycle.js";
import { createSubscriptionShieldTimeoutError } from "./subscription-shield.js";

describe("runWithProviderAttempt", () => {
  it("classifies a typed subscription shield timeout as retryable network failure", async () => {
    const handle = { lease: "worker-shield" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    const timeout = createSubscriptionShieldTimeoutError(30_000);

    await expect(runWithProviderAttempt(
      {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "shield", modelId: "worker-model" },
      },
      async () => { throw timeout; },
    )).rejects.toBe(timeout);

    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "shield",
      modelId: "worker-model",
      outcome: "retryable-error",
      phase: "stream",
      failureClass: "network",
    });
  });
});
