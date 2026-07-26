import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EvolutionStore } from "../core/evolution-store.js";
import { evaluatePendingCandidates, MIN_APPROVE_SCORE } from "../core/evolution-eval.js";

/**
 * Candidates shaped the way the harvester actually emits them.
 *
 * These fixtures used to carry `{ kind: "tool-failure-pattern", tool }` and
 * NOTHING else — a claim of a repeated failure with no evidence of repetition —
 * and the old gate approved them on a model's say-so. That is the defect the
 * admissibility rule exists for, and it was visible in this suite's own
 * fixtures. `evidenced: false` below preserves the old shape so the rejection
 * is asserted rather than merely assumed.
 */
async function storeWithPending(
  count: number,
  { now = () => Date.parse("2026-07-26T10:00:00.000Z"), evidenced = true } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "kyrei-evo-worker-"));
  const store = new EvolutionStore({ dataDir, now });
  for (let i = 0; i < count; i += 1) {
    await store.create({
      target: { kind: "reliability-hint", id: `tool:t${i}` },
      title: `Repeated t${i} failures`,
      summary: `Tool t${i} failed repeatedly.`,
      proposal: {
        kind: "tool-failure-pattern",
        tool: `t${i}`,
        ...(evidenced ? { occurrences: 3, samples: [`t${i} ENOENT`, `t${i} EACCES`] } : {}),
      },
    });
  }
  return { dataDir, store };
}

/** A canned generateText returning a fixed reply + optional usage. */
const cannedModel = (text: string, usage?: Record<string, number>) =>
  async () => ({ text, ...(usage ? { usage } : {}) }) as never;

describe("evaluatePendingCandidates (evolution worker core)", () => {
  it("approves a candidate with a non-empty receipt when the model approves", async () => {
    const { store } = await storeWithPending(1);
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel('{"verdict":"approve","score":0.9,"rationale":"clear and actionable"}'),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });
    expect(out).toMatchObject({ ok: true, evaluated: 1, approved: 1, rejected: 0 });
    const [candidate] = await store.list({ status: "approved" });
    expect(candidate.status).toBe("approved");
    expect(candidate.evidence.receipts.length).toBeGreaterThan(0);
    expect(candidate.evidence.metrics).toMatchObject({ score: 0.9 });
  });

  it("refuses to approve a low-confidence approval", async () => {
    // Regression: the gate was `verdict === "approve"` alone; score was read
    // only for display, so a 0.0-confidence approval became `approved` — the
    // sole precondition promotion checks before rewriting an artifact on disk.
    const { store } = await storeWithPending(1);
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel('{"verdict":"approve","score":0.0,"rationale":"not sure at all"}'),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });
    expect(out).toMatchObject({ ok: true, evaluated: 1, approved: 0, rejected: 1 });
    expect(await store.list({ status: "approved" })).toHaveLength(0);
    const [candidate] = await store.list({ status: "rejected" });
    expect(candidate.reason).toMatch(/^eval_low_score:/);
  });

  it("still approves at or above the confidence bar", async () => {
    const { store } = await storeWithPending(1);
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel(`{"verdict":"approve","score":${MIN_APPROVE_SCORE},"rationale":"borderline but sound"}`),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });
    expect(out).toMatchObject({ ok: true, approved: 1, rejected: 0 });
  });

  it("rejects a candidate with a reason when the model rejects", async () => {
    const { store } = await storeWithPending(1);
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel('{"verdict":"reject","score":0.1,"rationale":"too vague"}'),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });
    expect(out).toMatchObject({ ok: true, evaluated: 1, approved: 0, rejected: 1 });
    const [candidate] = await store.list({ status: "rejected" });
    expect(candidate.status).toBe("rejected");
    expect(candidate.reason).toBe("too vague");
  });

  it("rejects (not stuck evaluating) when the model reply is unparseable", async () => {
    const { store } = await storeWithPending(1);
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel("sorry, no json for you"),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });
    expect(out).toMatchObject({ ok: true, evaluated: 1, rejected: 1 });
    expect(await store.list({ status: "evaluating" })).toHaveLength(0);
    const [candidate] = await store.list({ status: "rejected" });
    expect(candidate.reason).toBe("eval_unparseable");
  });

  it("stops early once the tracked cost ceiling is reached", async () => {
    const { store } = await storeWithPending(5);
    let calls = 0;
    const out = await evaluatePendingCandidates(store, {
      generateText: async () => {
        calls += 1;
        return { text: '{"verdict":"approve","score":0.8,"rationale":"ok"}', usage: { inputTokens: 1_000_000, outputTokens: 0 } } as never;
      },
      model: {},
      costEntry: { inputPerM: 0.5, outputPerM: 0.5 }, // $0.50 per call
      ceiling: 0.6, // room for exactly one call, then spent(0.5) < 0.6 → one more, then stop
      targetModel: "gpt-4o-mini",
      abortMs: 0,
    });
    // First call spends 0.5 (<0.6 → continue), second reaches 1.0 (>=0.6 → stop before third).
    expect(calls).toBe(2);
    expect(out.evaluated).toBe(2);
    expect(out.costTracked).toBe(true);
    expect(await store.list({ status: "pending" })).toHaveLength(3);
  });

  it("reports untracked cost for an unregistered (zero-price) model and does not enforce a ceiling", async () => {
    const { store } = await storeWithPending(3);
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel('{"verdict":"approve","score":0.7,"rationale":"ok"}', { inputTokens: 999, outputTokens: 999 }),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      ceiling: 0.01,
      abortMs: 0,
    });
    // cost is untracked → ceiling never trips → all three evaluated.
    expect(out.evaluated).toBe(3);
    expect(out.costTracked).toBe(false);
  });

  it("refuses an unevidenced candidate even when the model is certain", async () => {
    // The shape these fixtures used to have: a claim of a repeated failure
    // carrying no evidence of repetition. It was approvable, because the only
    // gate was a model scoring its own confidence — and a judge's bias runs
    // toward false PASSES, which here means a self-modification that ships.
    const { store } = await storeWithPending(1, { evidenced: false });
    const out = await evaluatePendingCandidates(store, {
      generateText: cannedModel('{"verdict":"approve","score":1.0,"rationale":"absolutely certain"}'),
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });

    expect(out).toMatchObject({ ok: true, evaluated: 1, approved: 0, rejected: 1 });
    const [candidate] = await store.list({ status: "rejected" });
    expect(candidate.reason).toContain("evidence_insufficient");
  });

  it("does not spend a model call on a candidate that cannot be approved", async () => {
    let calls = 0;
    const { store } = await storeWithPending(1, { evidenced: false });
    await evaluatePendingCandidates(store, {
      generateText: async () => { calls += 1; return { text: '{"verdict":"approve","score":1}' } as never; },
      model: {},
      costEntry: { inputPerM: 0, outputPerM: 0 },
      abortMs: 0,
    });
    expect(calls).toBe(0);
  });
});
