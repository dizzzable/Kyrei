import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EvolutionExecutorStore } from "../core/evolution-executor-store.js";

async function fixture(options: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "kyrei-evo-exec-"));
  return { dataDir, store: new EvolutionExecutorStore({ dataDir, ...options }) };
}

describe("EvolutionExecutorStore", () => {
  it("captures prior state via begin and returns it through getPrior", async () => {
    const { store } = await fixture();
    const receiptId = await store.begin({
      candidateId: "evo_abc12345",
      kind: "skill_update",
      targetRef: "skill_0123456789abcdef01234567",
      priorState: { existed: true, content: "old content" },
    });
    expect(receiptId).toMatch(/^exec:evo_abc12345:/);
    const prior = await store.getPrior("evo_abc12345");
    expect(prior).toMatchObject({ kind: "skill_update", priorState: { existed: true, content: "old content" } });
  });

  it("surfaces an uncommitted apply as pending, and clears it after commit", async () => {
    const { store } = await fixture();
    await store.begin({ candidateId: "evo_pending1", kind: "profile_update", targetRef: "custom-a", priorState: { existed: true, content: "prior prompt" } });
    let pending = await store.pendingApplies();
    expect(pending.map((p) => p.candidateId)).toContain("evo_pending1");

    await store.commit("evo_pending1");
    pending = await store.pendingApplies();
    expect(pending.map((p) => p.candidateId)).not.toContain("evo_pending1");
  });

  it("redacts configured secrets from captured prior state", async () => {
    const secret = "sk-executor-secret-value";
    const { store } = await fixture({ getSensitiveValues: () => [secret] });
    await store.begin({
      candidateId: "evo_secret01",
      kind: "profile_update",
      targetRef: "custom-a",
      priorState: { existed: true, content: `prompt with ${secret} inside` },
    });
    const prior = await store.getPrior("evo_secret01");
    expect(JSON.stringify(prior)).not.toContain(secret);
    expect(JSON.stringify(prior)).toContain("[REDACTED]");
  });

  it("reloads durably from a fresh instance", async () => {
    const { dataDir, store } = await fixture();
    await store.begin({ candidateId: "evo_reload01", kind: "skill_create", targetRef: "my-skill", priorState: { existed: false } });
    const reloaded = new EvolutionExecutorStore({ dataDir });
    const prior = await reloaded.getPrior("evo_reload01");
    expect(prior).toMatchObject({ kind: "skill_create", priorState: { existed: false } });
  });
});
