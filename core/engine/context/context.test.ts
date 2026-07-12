import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { isOverflow, estimateMessages, heuristicCount } from "./tokens.js";
import { createCcrStore, ccrHash } from "./ccr.js";
import { pruneToolOutputs, firedCheckpointMark } from "./compaction.js";

describe("tokens", () => {
  it("isOverflow dual-trigger soft/hard", () => {
    const budget = { window: 1000, softPct: 0.75, hardPct: 0.9 };
    expect(isOverflow(500, null, budget).soft).toBe(false);
    expect(isOverflow(800, null, budget).soft).toBe(true);
    expect(isOverflow(800, null, budget).hard).toBe(false);
    expect(isOverflow(500, 950, budget).hard).toBe(true); // provider usage dominates
  });
  it("estimateMessages > 0 (heuristic path)", async () => {
    const msgs = [{ role: "user", content: "hello world this is a test" }] as ModelMessage[];
    expect(await estimateMessages(msgs, "llama3.1:8b")).toBeGreaterThan(0);
  });
  it("heuristic counts scale with length", () => {
    expect(heuristicCount("a".repeat(360))).toBeGreaterThan(heuristicCount("a".repeat(36)));
  });
});

describe("checkpoint marks", () => {
  it("fires 20/45/70% once each", () => {
    const fired = new Set<number>();
    expect(firedCheckpointMark(10, 100, fired)).toBe(null);
    expect(firedCheckpointMark(25, 100, fired)).toBe(0.2);
    expect(firedCheckpointMark(25, 100, fired)).toBe(null); // already fired
    expect(firedCheckpointMark(50, 100, fired)).toBe(0.45);
    expect(firedCheckpointMark(75, 100, fired)).toBe(0.7);
  });
});

describe("CCR (Property 6: reversible compression)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-ccr-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("put → get round-trips exactly", async () => {
    const store = createCcrStore(dir);
    const content = "секрет\nбольшой вывод\n".repeat(100);
    const hash = await store.put(content);
    expect(hash).toBe(ccrHash(content));
    expect(await store.get(hash)).toBe(content);
    expect(await store.has(hash)).toBe(true);
    expect(await store.get("sha256:" + "0".repeat(64))).toBe(null);
  });

  it("pruneToolOutputs prunes old large outputs and keeps them recallable", async () => {
    const store = createCcrStore(dir);
    const big = "LINE\n".repeat(2000);
    const messages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: big }] },
      { role: "user", content: "next" },
      { role: "assistant", content: "ok" },
    ] as unknown as ModelMessage[];

    const { messages: pruned, prunedCount } = await pruneToolOutputs(messages, store, {
      maxToolOutputChars: 1000,
      keepLastMessages: 2,
      pruneToChars: 200,
    });
    expect(prunedCount).toBe(1);
    const toolMsg = pruned[1] as unknown as { content: Array<{ output: string }> };
    const out = toolMsg.content[0]!.output;
    expect(out).toContain("truncated");
    const hash = out.match(/sha256:[0-9a-f]{64}/)?.[0];
    expect(hash).toBeTruthy();
    expect(await store.get(hash!)).toBe(big); // original recoverable
  });
});
