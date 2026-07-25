import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { harvestCandidatesFromTrajectory } from "../core/evolution-harvest.js";
import { classifyExecution } from "../core/evolution-executor.js";

const digestOf = (proposal: unknown) =>
  createHash("sha256").update(JSON.stringify(proposal)).digest("hex");

describe("harvestCandidatesFromTrajectory", () => {
  it("emits a reliability-hint for a repeated tool failure cluster", () => {
    const out = harvestCandidatesFromTrajectory(
      {
        sessionId: "s1",
        success: false,
        skillNames: ["some-skill"],
        failures: ["read_file: ENOENT a", "read_file: ENOENT b"],
      },
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].target).toEqual({ kind: "reliability-hint", id: "tool:read_file" });
    expect(out[0].proposal.kind).toBe("tool-failure-pattern");
    expect(out[0].proposal.occurrences).toBe(2);
    expect(out[0].risk).toBe("low");
  });

  it("drops a candidate whose digest is already journaled", () => {
    const traj = {
      sessionId: "s1",
      success: false,
      skillNames: ["x"],
      failures: ["grep: boom", "grep: boom"],
    };
    const first = harvestCandidatesFromTrajectory(traj, new Set());
    expect(first).toHaveLength(1);
    const seen = new Set([digestOf(first[0].proposal)]);
    const second = harvestCandidatesFromTrajectory(traj, seen);
    expect(second).toHaveLength(0);
  });

  it("produces nothing for a clean successful trajectory", () => {
    const out = harvestCandidatesFromTrajectory(
      { sessionId: "s1", success: true, failures: [], healHandoff: false },
      new Set(),
    );
    expect(out).toHaveLength(0);
  });

  it("emits a heal-handoff hint on a failed escalated turn", () => {
    const out = harvestCandidatesFromTrajectory(
      { sessionId: "s1", success: false, healHandoff: true, failures: [], goal: "fix build" },
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].target).toEqual({ kind: "reliability-hint", id: "heal-handoff" });
    expect(out[0].proposal.kind).toBe("heal-handoff");
  });

  it("respects maxPerTurn", () => {
    const failures: string[] = [];
    for (const tool of ["a", "b", "c", "d", "e"]) failures.push(`${tool}: x`, `${tool}: y`);
    const out = harvestCandidatesFromTrajectory(
      { sessionId: "s1", success: false, skillNames: ["k"], failures },
      new Set(),
      { maxPerTurn: 2 },
    );
    expect(out).toHaveLength(2);
  });

  it("emits a skill playbook draft only for orphan failures (no skill context)", () => {
    const orphan = harvestCandidatesFromTrajectory(
      { sessionId: "s1", success: false, skillNames: [], skillIds: [], failures: ["build: fail", "build: fail"] },
      new Set(),
    );
    const kinds = orphan.map((c) => c.target.kind);
    expect(kinds).toContain("reliability-hint");
    expect(kinds).toContain("skill");
    // Never emits policy-mutation targets.
    expect(kinds).not.toContain("prompt-profile");
    expect(kinds).not.toContain("memory-ranking");
  });

  it("does not draft a skill when a skill was in play", () => {
    const covered = harvestCandidatesFromTrajectory(
      { sessionId: "s1", success: false, skillNames: ["some-skill"], failures: ["build: fail", "build: fail"] },
      new Set(),
    );
    expect(covered.map((c) => c.target.kind)).not.toContain("skill");
  });

  it("enriches the skill draft with a name + content the executor can create", () => {
    const orphan = harvestCandidatesFromTrajectory(
      { sessionId: "s1", success: false, skillNames: [], skillIds: [], failures: ["web_search: 429", "web_search: 429"] },
      new Set(),
    );
    const skill = orphan.find((c) => c.target.kind === "skill");
    expect(skill).toBeDefined();
    // The draft carries a usable name and a SKILL.md body (no frontmatter).
    expect(skill!.proposal.name).toBe("playbook-web_search");
    expect(typeof skill!.proposal.content).toBe("string");
    expect(skill!.proposal.content).not.toContain("---\nname:");
    expect(skill!.proposal.content).toContain("Trajectory playbook");
    // Closing the loop: the executor now plans a real skill_create, not reject_stale.
    const plan = classifyExecution({ target: skill!.target, proposal: skill!.proposal });
    expect(plan.action).toBe("skill_create");
    expect(plan.name).toBe("playbook-web_search");
  });
});
