import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUsageLedger,
  normalizeUsageEvent,
  summarizeUsageEvents,
} from "../core/usage-ledger.js";

describe("usage-ledger", () => {
  it("normalizes events and drops empty noise", () => {
    expect(normalizeUsageEvent(null)).toBeNull();
    expect(normalizeUsageEvent({ providerId: "x" })).toBeNull();
    const ok = normalizeUsageEvent({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.00123,
      kind: "chat_turn",
      status: "complete",
    });
    expect(ok).toMatchObject({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      kind: "chat_turn",
    });
    expect(ok?.costUsd).toBeCloseTo(0.00123);
  });

  it("summarizes by provider, model, and day", () => {
    const summary = summarizeUsageEvents([
      {
        id: "1",
        ts: "2026-07-10T12:00:00.000Z",
        kind: "chat_turn",
        providerId: "openai",
        modelId: "gpt-4o-mini",
        totalTokens: 100,
        costUsd: 0.01,
      },
      {
        id: "2",
        ts: "2026-07-11T12:00:00.000Z",
        kind: "chat_turn",
        providerId: "anthropic",
        modelId: "claude",
        totalTokens: 50,
        costUsd: 0.05,
      },
      {
        id: "3",
        ts: "2026-07-11T15:00:00.000Z",
        kind: "chat_turn",
        providerId: "openai",
        modelId: "gpt-4o-mini",
        totalTokens: 25,
        costUsd: 0.002,
      },
    ]);
    expect(summary.requestCount).toBe(3);
    expect(summary.totalTokens).toBe(175);
    expect(summary.byProvider[0]?.key).toBe("openai");
    expect(summary.byDay).toHaveLength(2);
  });

  it("persists append-only jsonl and returns summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kyrei-usage-"));
    const ledger = createUsageLedger({ dataDir: dir });
    await ledger.record({
      providerId: "openai",
      modelId: "m",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      kind: "chat_turn",
      status: "complete",
    });
    await ledger.record({
      providerId: "openai",
      modelId: "m",
      totalTokens: 20,
      costUsd: 0.002,
      kind: "chat_turn",
    });
    const raw = await readFile(ledger.path, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    const summary = await ledger.summary({ days: 30 });
    expect(summary.requestCount).toBe(2);
    expect(summary.totalTokens).toBe(35);
  });
});
