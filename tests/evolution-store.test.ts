import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EvolutionStore } from "../core/evolution-store.js";

async function fixture(options: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "kyrei-evolution-"));
  return { dataDir, store: new EvolutionStore({ dataDir, ...options }) };
}

describe("EvolutionStore", () => {
  it("persists proposal-first candidates and rebuilds their projection", async () => {
    let now = Date.parse("2026-07-18T10:00:00.000Z");
    const { dataDir, store } = await fixture({ now: () => now });
    const created = await store.create({
      target: { kind: "skill", id: "skill:testing" },
      title: "Tighten test discovery",
      summary: "Candidate only; no active Skill is mutated.",
      proposal: { description: "Use the repository test command." },
      provenance: { sessionId: "session-1" },
    });
    expect(created.status).toBe("pending");
    expect(created.revision).toBe(1);

    now += 1_000;
    const evaluating = await store.transition(created.id, {
      expectedRevision: 1,
      status: "evaluating",
      reason: "Held-out replay started",
    });
    expect(evaluating.status).toBe("evaluating");

    const reloaded = new EvolutionStore({ dataDir });
    expect(await reloaded.get(created.id)).toMatchObject({
      id: created.id,
      status: "evaluating",
      revision: 2,
    });
  });

  it("fails closed on invalid transitions, stale revisions and missing verifier receipts", async () => {
    const { store } = await fixture();
    const created = await store.create({
      target: { kind: "prompt-profile", id: "kyrei-main" },
      title: "Improve the default profile",
      summary: "A bounded prompt-profile proposal.",
      proposal: { append: "Verify completion evidence." },
    });
    await expect(store.transition(created.id, { expectedRevision: 1, status: "promoted" }))
      .rejects.toThrow("evolution_transition_invalid");
    const evaluating = await store.transition(created.id, { expectedRevision: 1, status: "evaluating" });
    await expect(store.transition(created.id, { expectedRevision: 1, status: "rejected" }))
      .rejects.toThrow("evolution_candidate_revision_conflict");
    await expect(store.transition(created.id, { expectedRevision: evaluating.revision, status: "approved" }))
      .rejects.toThrow("evolution_verifier_receipt_required");
  });

  it("redacts configured secrets before persistence", async () => {
    const secret = "sk-super-secret-value";
    const { dataDir, store } = await fixture({ getSensitiveValues: () => [secret] });
    const created = await store.create({
      target: { kind: "reliability-hint", id: "timeouts" },
      title: "Classify a timeout",
      summary: `Never retain ${secret}`,
      proposal: { notes: `observed ${secret}` },
    });
    expect(JSON.stringify(created)).not.toContain(secret);
    const raw = await readFile(join(dataDir, "evolution", "events.jsonl"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects immutable policy as an evolution target", async () => {
    const { store } = await fixture();
    await expect(store.create({
      target: { kind: "core-policy", id: "system" },
      title: "Unsafe target",
      summary: "Immutable policy is release-owned.",
      proposal: {},
    })).rejects.toThrow("evolution_target_not_allowlisted");
  });

  describe("gc(retentionDays)", () => {
    const seed = (store: EvolutionStore, id: string, kind = "reliability-hint") => store.create({
      id,
      target: { kind, id: `t:${id}` },
      title: `Candidate ${id}`,
      summary: `Summary for ${id}`,
      proposal: { note: id },
    });

    it("prunes terminal candidates older than the window, keeps live ones", async () => {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      const { dataDir, store } = await fixture({ now: () => now });
      // Old + terminal (rejected) → dropped.
      const oldTerminal = await seed(store, "evo_oldterminal");
      now += 1_000;
      await store.transition(oldTerminal.id, { expectedRevision: 1, status: "rejected" });
      // Old + non-terminal (pending) → kept regardless of age.
      const oldPending = await seed(store, "evo_oldpending");
      // Advance far past retention (200 days).
      now += 200 * 86_400_000;
      // Fresh + terminal → kept (within window).
      const freshTerminal = await seed(store, "evo_freshterminal");
      now += 1_000;
      await store.transition(freshTerminal.id, { expectedRevision: 1, status: "rejected" });

      const result = await store.gc(180);
      expect(result.pruned).toBe(1);

      const remaining = (await store.list({ limit: 500 })).map((c) => c.id).sort();
      expect(remaining).toEqual(["evo_freshterminal", "evo_oldpending"].sort());
      expect(await store.get(oldTerminal.id)).toBeNull();

      // Journal is still readable from a fresh store after rewrite.
      const reloaded = new EvolutionStore({ dataDir });
      expect(await reloaded.get(oldPending.id)).toMatchObject({ id: oldPending.id, status: "pending" });
      expect(await reloaded.get(oldTerminal.id)).toBeNull();
    });

    it("is a no-op when nothing qualifies (file untouched)", async () => {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      const { dataDir, store } = await fixture({ now: () => now });
      await seed(store, "evo_keepalive1");
      now += 1_000;
      await store.flush();
      const before = await readFile(join(dataDir, "evolution", "events.jsonl"), "utf8");
      const result = await store.gc(180);
      expect(result.pruned).toBe(0);
      const after = await readFile(join(dataDir, "evolution", "events.jsonl"), "utf8");
      expect(after).toBe(before);
    });
  });
});
