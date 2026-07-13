import { describe, expect, it } from "vitest";
import {
  TeamTaskGraphValidationError,
  buildTeamTaskWaves,
  validateTeamTaskGraph,
} from "./graph.js";
import type { TeamTaskSpec } from "./types.js";

describe("Team task graph validation", () => {
  it("reports duplicate task ids", () => {
    const validation = validateTeamTaskGraph([
      { id: "research", goal: "Research the problem" },
      { id: "research", goal: "Research it again" },
    ]);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual([
      expect.objectContaining({ code: "duplicate_task_id", taskId: "research" }),
    ]);
  });

  it("reports missing and self dependencies", () => {
    const validation = validateTeamTaskGraph([
      { id: "research", goal: "Research", dependsOn: ["unknown"] },
      { id: "review", goal: "Review", dependsOn: ["review"] },
    ]);

    expect(validation.issues).toEqual([
      expect.objectContaining({
        code: "missing_dependency",
        taskId: "research",
        dependencyId: "unknown",
      }),
      expect.objectContaining({
        code: "self_dependency",
        taskId: "review",
        dependencyId: "review",
      }),
    ]);
  });

  it("reports dependency cycles with a closed path", () => {
    const validation = validateTeamTaskGraph([
      { id: "a", goal: "A", dependsOn: ["b"] },
      { id: "b", goal: "B", dependsOn: ["c"] },
      { id: "c", goal: "C", dependsOn: ["a"] },
    ]);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual({
      code: "dependency_cycle",
      taskId: "a",
      cycle: ["a", "b", "c", "a"],
    });
  });
});

describe("Team task graph waves", () => {
  it("builds deterministic topological waves while preserving declaration order", () => {
    const tasks: readonly TeamTaskSpec[] = [
      { id: "z", goal: "First root" },
      { id: "a", goal: "Second root" },
      { id: "c", goal: "Uses z", dependsOn: ["z"] },
      { id: "b", goal: "Uses a", dependsOn: ["a"] },
      { id: "done", goal: "Synthesize", dependsOn: ["b", "c"] },
    ];

    const ids = (): string[][] =>
      buildTeamTaskWaves(tasks).map((wave) => wave.map((task) => task.id));

    expect(ids()).toEqual([["z", "a"], ["c", "b"], ["done"]]);
    expect(ids()).toEqual([["z", "a"], ["c", "b"], ["done"]]);
  });

  it("refuses to schedule an invalid graph", () => {
    expect(() =>
      buildTeamTaskWaves([{ id: "a", goal: "A", dependsOn: ["missing"] }]),
    ).toThrow(TeamTaskGraphValidationError);
  });
});
