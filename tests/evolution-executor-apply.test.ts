import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillsStore } from "../core/skills-store.js";
import { EvolutionExecutorStore } from "../core/evolution-executor-store.js";
import { classifyExecution } from "../core/evolution-executor.js";

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kyrei-exec-apply-"));
  dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Replicates the gateway's skill promotion sequence: begin → mutate → commit. */
async function applySkillUpdate(skills: SkillsStore, exec: EvolutionExecutorStore, candidate: { id: string; target: { id: string }; proposal: { content: string } }) {
  const before = await skills.get(candidate.target.id);
  await exec.begin({
    candidateId: candidate.id,
    kind: "skill_update",
    targetRef: candidate.target.id,
    priorState: { existed: true, content: before.content },
  });
  await skills.update(candidate.target.id, { content: candidate.proposal.content });
  await exec.commit(candidate.id);
}

describe("evolution executor apply + rollback (integration)", () => {
  it("mutates an owned skill on promote and restores it on rollback", async () => {
    const skills = new SkillsStore({ dataDir });
    await skills.load();
    const created = await skills.create({
      name: "demo-skill",
      content: "---\nname: demo-skill\ndescription: original\n---\n\n# Original body\n",
    });
    const originalContent = (await skills.get(created.id)).content;

    const exec = new EvolutionExecutorStore({ dataDir });
    const candidate = {
      id: "evo_apply1234",
      target: { kind: "skill", id: created.id },
      proposal: { content: "---\nname: demo-skill\ndescription: improved\n---\n\n# Improved body\n" },
    };

    // Sanity: the classifier plans a skill_update for this candidate.
    expect(classifyExecution(candidate).action).toBe("skill_update");

    await applySkillUpdate(skills, exec, candidate);

    // Mutation applied.
    const afterUpdate = await skills.get(created.id);
    expect(afterUpdate.content).toContain("Improved body");
    expect(afterUpdate.content).not.toContain("Original body");

    // Prior state captured for rollback.
    const prior = await exec.getPrior(candidate.id);
    expect(prior?.priorState.content).toBe(originalContent);

    // Rollback restores the original content.
    await skills.update(created.id, { content: prior!.priorState.content! });
    const afterRollback = await skills.get(created.id);
    expect(afterRollback.content).toContain("Original body");
    expect(afterRollback.content).not.toContain("Improved body");
  });

  it("refuses to plan a mutation for a synthetic harvested skill draft", async () => {
    // A harvested skill candidate (playbook:<tool>, no content) must not map to
    // any real skill mutation.
    const plan = classifyExecution({
      id: "evo_stale5678",
      target: { kind: "skill", id: "playbook:web_search" },
      proposal: { kind: "trajectory-playbook" },
    });
    expect(plan.action).toBe("reject_stale");
  });
});
