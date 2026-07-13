import { describe, expect, it } from "vitest";
import { executeTeamTaskGraph } from "./execute.js";
import type { TeamArtifact, TeamTaskRunner, TeamTaskSpec } from "./types.js";

function artifact(taskId: string, summary = taskId): TeamArtifact {
  return {
    taskId,
    summary,
    provenance: [`task:${taskId}`],
    confidence: 1,
    evidence: [],
    validation: [],
    uncertainties: [],
    whatWasNotChecked: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("executeTeamTaskGraph", () => {
  it("enforces one global concurrency bound and returns results in task order", async () => {
    const tasks: readonly TeamTaskSpec[] = ["a", "b", "c", "d"].map((id) => ({
      id,
      goal: id,
    }));
    const gates = new Map(tasks.map((task) => [task.id, deferred()]));
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const execution = executeTeamTaskGraph(
      tasks,
      async ({ task }) => {
        started.push(task.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates.get(task.id)!.promise;
        active -= 1;
        return artifact(task.id);
      },
      { maxConcurrency: 2 },
    );

    expect(started).toEqual(["a", "b"]);
    gates.get("b")!.resolve();
    await nextTurn();
    expect(started).toEqual(["a", "b", "c"]);
    gates.get("a")!.resolve();
    await nextTurn();
    expect(started).toEqual(["a", "b", "c", "d"]);
    gates.get("d")!.resolve();
    gates.get("c")!.resolve();

    const results = await execution;
    expect(maximumActive).toBe(2);
    expect(results.map((result) => result.task.id)).toEqual(["a", "b", "c", "d"]);
    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("injects successful dependency artifacts in declared dependency order", async () => {
    const tasks: readonly TeamTaskSpec[] = [
      { id: "left", goal: "Left" },
      { id: "right", goal: "Right" },
      { id: "join", goal: "Join", dependsOn: ["right", "left"] },
    ];
    let injected: ReadonlyMap<string, TeamArtifact> | undefined;

    const results = await executeTeamTaskGraph(
      tasks,
      async ({ task, dependencyArtifacts }) => {
        if (task.id === "join") injected = dependencyArtifacts;
        return artifact(task.id, `result:${task.id}`);
      },
      { maxConcurrency: 2 },
    );

    expect([...injected!.keys()]).toEqual(["right", "left"]);
    expect([...injected!.values()].map((value) => value.summary)).toEqual([
      "result:right",
      "result:left",
    ]);
    expect(results.at(-1)?.status).toBe("succeeded");
  });

  it("blocks dependent tasks after a failure while continuing independent work", async () => {
    const tasks: readonly TeamTaskSpec[] = [
      { id: "fail", goal: "Fails" },
      { id: "child", goal: "Blocked child", dependsOn: ["fail"] },
      { id: "grandchild", goal: "Blocked descendant", dependsOn: ["child"] },
      { id: "independent", goal: "Still runs" },
    ];
    const started: string[] = [];

    const results = await executeTeamTaskGraph(
      tasks,
      async ({ task }) => {
        started.push(task.id);
        if (task.id === "fail") throw new Error("planned failure");
        return artifact(task.id);
      },
      { maxConcurrency: 2 },
    );

    expect(started).toEqual(["fail", "independent"]);
    expect(results.map((result) => result.status)).toEqual([
      "failed",
      "blocked",
      "blocked",
      "succeeded",
    ]);
    expect(results[1]).toMatchObject({ status: "blocked", blockedBy: ["fail"] });
    expect(results[2]).toMatchObject({ status: "blocked", blockedBy: ["child"] });
  });

  it("does not start queued tasks after cancellation", async () => {
    const controller = new AbortController();
    const tasks: readonly TeamTaskSpec[] = [
      { id: "a", goal: "Starts" },
      { id: "b", goal: "Queued" },
      { id: "c", goal: "Queued" },
    ];
    const started: string[] = [];

    const runner: TeamTaskRunner = async ({ task, signal }) => {
      started.push(task.id);
      expect(signal.aborted).toBe(false);
      controller.abort("stop");
      return artifact(task.id);
    };

    const results = await executeTeamTaskGraph(tasks, runner, {
      maxConcurrency: 1,
      signal: controller.signal,
    });

    expect(started).toEqual(["a"]);
    expect(results.map((result) => result.status)).toEqual([
      "aborted",
      "aborted",
      "aborted",
    ]);
  });

  it("does not start anything when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before execution"));
    let starts = 0;

    const results = await executeTeamTaskGraph(
      [
        { id: "a", goal: "A" },
        { id: "b", goal: "B", dependsOn: ["a"] },
      ],
      async ({ task }) => {
        starts += 1;
        return artifact(task.id);
      },
      { maxConcurrency: 1, signal: controller.signal },
    );

    expect(starts).toBe(0);
    expect(results.map((result) => result.status)).toEqual(["aborted", "aborted"]);
  });

  it("requires a positive integer concurrency bound", async () => {
    const runner: TeamTaskRunner = async ({ task }) => artifact(task.id);

    await expect(
      executeTeamTaskGraph([{ id: "a", goal: "A" }], runner, { maxConcurrency: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      executeTeamTaskGraph([{ id: "a", goal: "A" }], runner, { maxConcurrency: 1.5 }),
    ).rejects.toThrow(RangeError);
  });
});
