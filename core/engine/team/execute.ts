import { assertValidTeamTaskGraph } from "./graph.js";
import type {
  ExecuteTeamTaskGraphOptions,
  TeamArtifact,
  TeamTaskResult,
  TeamTaskRunner,
  TeamTaskSpec,
} from "./types.js";

type ExecutionState = "pending" | "running" | "settled";

/**
 * Execute a valid task graph with one global concurrency budget.
 *
 * Scheduling is dependency-driven rather than wave-barrier-driven: a newly
 * unblocked task can start as soon as a slot is free. Returned results still
 * follow task declaration order, independent of completion order.
 */
export async function executeTeamTaskGraph(
  tasks: readonly TeamTaskSpec[],
  runner: TeamTaskRunner,
  options: ExecuteTeamTaskGraphOptions,
): Promise<readonly TeamTaskResult[]> {
  if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new RangeError("maxConcurrency must be a positive integer");
  }
  assertValidTeamTaskGraph(tasks);

  const taskIndex = new Map(tasks.map((task, index) => [task.id, index]));
  const dependants = tasks.map(() => [] as number[]);
  tasks.forEach((task, index) => {
    for (const dependencyId of task.dependsOn ?? []) {
      dependants[taskIndex.get(dependencyId)!]!.push(index);
    }
  });

  const signal = options.signal ?? new AbortController().signal;
  const states: ExecutionState[] = tasks.map(() => "pending");
  const results: Array<TeamTaskResult | undefined> = tasks.map(() => undefined);
  const ready = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => (task.dependsOn ?? []).length === 0)
    .map(({ index }) => index);

  let active = 0;
  let settled = 0;

  return await new Promise<readonly TeamTaskResult[]>((resolve) => {
    const setResult = (index: number, result: TeamTaskResult): boolean => {
      if (states[index] === "settled") return false;
      states[index] = "settled";
      results[index] = result;
      settled += 1;
      return true;
    };

    const blockTask = (index: number, blockedBy: readonly string[]): void => {
      if (states[index] !== "pending") return;
      const task = tasks[index]!;
      setResult(index, { task, status: "blocked", blockedBy });
      for (const dependantIndex of dependants[index]!) {
        blockTask(dependantIndex, [task.id]);
      }
    };

    const abortQueued = (): void => {
      ready.length = 0;
      tasks.forEach((task, index) => {
        if (states[index] === "pending") {
          setResult(index, { task, status: "aborted", reason: signal.reason });
        }
      });
    };

    const cleanupAndResolve = (): boolean => {
      if (settled !== tasks.length || active !== 0) return false;
      signal.removeEventListener("abort", abortQueued);
      resolve(results as TeamTaskResult[]);
      return true;
    };

    const enqueueDependants = (index: number): void => {
      for (const dependantIndex of dependants[index]!) {
        if (states[dependantIndex] !== "pending") continue;
        const dependant = tasks[dependantIndex]!;
        const dependencyResults = (dependant.dependsOn ?? []).map(
          (dependencyId) => results[taskIndex.get(dependencyId)!],
        );
        const blockingDependencies = dependencyResults
          .filter(
            (result): result is Extract<TeamTaskResult, { status: "failed" | "blocked" }> =>
              result?.status === "failed" || result?.status === "blocked",
          )
          .map((result) => result.task.id);

        if (blockingDependencies.length > 0) {
          blockTask(dependantIndex, blockingDependencies);
        } else if (dependencyResults.every((result) => result?.status === "succeeded")) {
          ready.push(dependantIndex);
        }
      }
    };

    const dependencyArtifactsFor = (task: TeamTaskSpec): ReadonlyMap<string, TeamArtifact> => {
      const entries = (task.dependsOn ?? []).map((dependencyId) => {
        const result = results[taskIndex.get(dependencyId)!];
        if (result?.status !== "succeeded") {
          throw new Error(`Dependency ${dependencyId} did not produce an artifact`);
        }
        return [dependencyId, result.artifact] as const;
      });
      return new Map(entries);
    };

    let pump: () => void;

    const startTask = (index: number): void => {
      if (states[index] !== "pending" || signal.aborted) return;
      const task = tasks[index]!;
      states[index] = "running";
      active += 1;

      let operation: Promise<TeamArtifact>;
      try {
        operation = Promise.resolve(
          runner({
            task,
            dependencyArtifacts: dependencyArtifactsFor(task),
            signal,
          }),
        );
      } catch (error) {
        operation = Promise.reject(error);
      }

      void operation
        .then(
          (artifact) => {
            if (signal.aborted) {
              setResult(index, { task, status: "aborted", reason: signal.reason });
            } else {
              setResult(index, { task, status: "succeeded", artifact });
              enqueueDependants(index);
            }
          },
          (error: unknown) => {
            if (signal.aborted) {
              setResult(index, { task, status: "aborted", reason: signal.reason ?? error });
            } else {
              setResult(index, { task, status: "failed", error });
              for (const dependantIndex of dependants[index]!) {
                blockTask(dependantIndex, [task.id]);
              }
            }
          },
        )
        .then(() => {
          active -= 1;
          pump();
        });
    };

    pump = (): void => {
      if (signal.aborted) abortQueued();

      while (active < options.maxConcurrency && ready.length > 0 && !signal.aborted) {
        const index = ready.shift()!;
        if (states[index] === "pending") startTask(index);
      }

      cleanupAndResolve();
    };

    signal.addEventListener("abort", abortQueued);
    pump();
  });
}
