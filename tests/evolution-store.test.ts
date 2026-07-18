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
});
