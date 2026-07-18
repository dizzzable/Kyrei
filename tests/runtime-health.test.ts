import { describe, expect, it, vi } from "vitest";

import { RuntimeHealthGate } from "../core/runtime-health.js";

describe("RuntimeHealthGate", () => {
  it("coalesces a concurrent probe and reuses the bounded cache", async () => {
    let resolve!: (value: { state: string; count: number }) => void;
    const operation = vi.fn(() => new Promise<{ state: string; count: number }>((done) => { resolve = done; }));
    const gate = new RuntimeHealthGate({ classify: () => "healthy" });
    const first = gate.probe("index", operation);
    const second = gate.probe("index", operation);
    await Promise.resolve();
    resolve({ state: "ready", count: 2 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "ready", count: 2 }),
      expect.objectContaining({ state: "ready", count: 2 }),
    ]);
    await gate.probe("index", operation);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good snapshot through one failure and exposes a sustained outage", async () => {
    let now = 1_000;
    const gate = new RuntimeHealthGate({
      cacheTtlMs: 0,
      failureThreshold: 2,
      retryDelayMs: 500,
      now: () => now,
      classify: (value) => value?.state === "ready" ? "healthy" : "failure",
    });
    await expect(gate.probe("mirror", async () => ({ state: "ready", count: 9 }))).resolves.toMatchObject({
      state: "ready",
    });
    now += 100;
    await expect(gate.probe("mirror", async () => ({ state: "error", reason: "sqlite_busy" }), { force: true })).resolves.toMatchObject({
      state: "ready",
      count: 9,
      degraded: true,
      stale: true,
      consecutiveFailures: 1,
      healthReason: "sqlite_busy",
    });
    now += 100;
    await expect(gate.probe("mirror", async () => ({ state: "error", reason: "sqlite_busy" }), { force: true })).resolves.toMatchObject({
      state: "error",
      degraded: true,
      stale: true,
      consecutiveFailures: 2,
    });
  });

  it("does not misclassify stable disabled or not-initialized states as flapping failures", async () => {
    const gate = new RuntimeHealthGate({
      cacheTtlMs: 0,
      classify: (value) => value?.state === "ready" ? "healthy" : value?.state === "error" ? "failure" : "neutral",
    });
    await expect(gate.probe("gbrain", async () => ({ state: "not_initialized" }))).resolves.toMatchObject({
      state: "not_initialized",
    });
  });
});
