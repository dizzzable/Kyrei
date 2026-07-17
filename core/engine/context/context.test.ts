import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { isOverflow, estimateMessages, heuristicCount, providerUsageFromSteps } from "./tokens.js";
import { createCcrStore, ccrHash } from "./ccr.js";
import {
  pruneToolOutputs,
  firedCheckpointMark,
  selectProtectWindows,
  buildHeuristicSummary,
  reassembleWithSummary,
  summarizeMiddleTurns,
  SUMMARY_END_MARKER,
} from "./compaction.js";

describe("tokens", () => {
  it("isOverflow dual-trigger soft/hard", () => {
    const budget = { window: 1000, softPct: 0.75, hardPct: 0.9 };
    expect(isOverflow(500, null, budget).soft).toBe(false);
    expect(isOverflow(800, null, budget).soft).toBe(true);
    expect(isOverflow(800, null, budget).hard).toBe(false);
    expect(isOverflow(500, 950, budget).hard).toBe(true); // provider usage dominates
  });
  it("providerUsageFromSteps prefers last-step input (not sticky max)", () => {
    expect(providerUsageFromSteps([])).toBe(null);
    expect(providerUsageFromSteps([{ usage: { outputTokens: 10 } }])).toBe(null);
    // After compaction, later step has lower input — use last, not historical max.
    expect(providerUsageFromSteps([
      { usage: { inputTokens: 900, outputTokens: 20, totalTokens: 920 } },
      { usage: { inputTokens: 200, outputTokens: 5, totalTokens: 205 } },
    ])).toBe(200);
    expect(providerUsageFromSteps([
      { usage: { inputTokens: 800 } },
    ])).toBe(800);
    // Fall back to total when input missing.
    expect(providerUsageFromSteps([
      { usage: { totalTokens: 500 } },
    ])).toBe(500);
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
    // Wave B1 smart compress still archives full body under a sha256 hash.
    expect(out).toMatch(/tool-compress|truncated/);
    const hash = out.match(/sha256:[0-9a-f]{64}/)?.[0];
    expect(hash).toBeTruthy();
    expect(await store.get(hash!)).toBe(big); // original recoverable
  });
});

describe("stage B middle summary", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-sum-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("selectProtectWindows keeps head/tail and requires savings", () => {
    const msgs = Array.from({ length: 16 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i} `.repeat(5),
    })) as ModelMessage[];
    const win = selectProtectWindows(msgs, {
      protectFirstN: 2,
      protectLastN: 4,
      summaryMinMessages: 12,
    });
    expect(win.canSummarize).toBe(true);
    expect(win.head.length).toBeGreaterThan(0);
    expect(win.tail.length).toBeGreaterThan(0);
    expect(win.middle.length).toBeGreaterThan(0);
    expect(win.head.length + win.middle.length + win.tail.length).toBe(msgs.length);
  });

  it("buildHeuristicSummary is reference-only with end marker", () => {
    const middle = [
      { role: "user", content: "Please implement dark mode" },
      { role: "assistant", content: "Decided: use CSS variables.\nNext: wire Settings toggle." },
    ] as ModelMessage[];
    const text = buildHeuristicSummary(middle);
    expect(text).toMatch(/reference only/i);
    expect(text).toContain(SUMMARY_END_MARKER);
    expect(text.toLowerCase()).toMatch(/task|done|open|dark mode|css/i);
  });

  it("reassembleWithSummary inserts one summary message", () => {
    const head = [{ role: "user", content: "start" }] as ModelMessage[];
    const tail = [{ role: "user", content: "latest" }] as ModelMessage[];
    const out = reassembleWithSummary(head, "## Context summary (reference only)\nok\n--- END OF CONTEXT SUMMARY ---", tail);
    expect(out).toHaveLength(3);
    expect(String((out[1] as { content: string }).content)).toContain("reference only");
  });

  it("summarizeMiddleTurns stores middle in CCR", async () => {
    const store = createCcrStore(dir);
    const msgs = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message body ${i} with enough text for distill path`,
    })) as ModelMessage[];
    const result = await summarizeMiddleTurns(msgs, {
      ccr: store,
      protect: { protectFirstN: 1, protectLastN: 3, summaryMinMessages: 10 },
    });
    expect(result.summarized).toBe(true);
    expect(result.via).toBe("heuristic");
    expect(result.middleCcrHash).toMatch(/^sha256:/);
    expect(await store.get(result.middleCcrHash!)).toBeTruthy();
    expect(result.messages.length).toBeLessThan(msgs.length);
  });
});
