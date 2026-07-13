import type { TeamTaskSpec } from "./types.js";

export type TeamTaskGraphIssueCode =
  | "duplicate_task_id"
  | "missing_dependency"
  | "self_dependency"
  | "dependency_cycle";

export interface TeamTaskGraphIssue {
  readonly code: TeamTaskGraphIssueCode;
  readonly taskId: string;
  readonly dependencyId?: string;
  readonly cycle?: readonly string[];
}

export interface TeamTaskGraphValidation {
  readonly valid: boolean;
  readonly issues: readonly TeamTaskGraphIssue[];
}

export class TeamTaskGraphValidationError extends Error {
  readonly issues: readonly TeamTaskGraphIssue[];

  constructor(issues: readonly TeamTaskGraphIssue[]) {
    super(`Invalid Team task graph (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "TeamTaskGraphValidationError";
    this.issues = issues;
  }
}

/** Validate identity and dependency invariants without mutating the task list. */
export function validateTeamTaskGraph(
  tasks: readonly TeamTaskSpec[],
): TeamTaskGraphValidation {
  const issues: TeamTaskGraphIssue[] = [];
  const taskById = new Map<string, TeamTaskSpec>();
  const taskOrder = new Map<string, number>();
  const duplicateIds = new Set<string>();

  tasks.forEach((task, index) => {
    if (taskById.has(task.id)) {
      if (!duplicateIds.has(task.id)) {
        issues.push({ code: "duplicate_task_id", taskId: task.id });
        duplicateIds.add(task.id);
      }
      return;
    }
    taskById.set(task.id, task);
    taskOrder.set(task.id, index);
  });

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (dependencyId === task.id) {
        issues.push({ code: "self_dependency", taskId: task.id, dependencyId });
      } else if (!taskById.has(dependencyId)) {
        issues.push({ code: "missing_dependency", taskId: task.id, dependencyId });
      }
    }
  }

  const visitState = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const reportCycle = (path: readonly string[]): void => {
    const nodes = path.slice(0, -1);
    if (nodes.length === 0) return;
    const canonicalStart = nodes.reduce((best, id, index) => {
      const bestOrder = taskOrder.get(nodes[best]!) ?? Number.MAX_SAFE_INTEGER;
      const order = taskOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
      return order < bestOrder ? index : best;
    }, 0);
    const canonicalNodes = [
      ...nodes.slice(canonicalStart),
      ...nodes.slice(0, canonicalStart),
    ];
    const key = [...canonicalNodes]
      .sort((left, right) =>
        (taskOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (taskOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
      )
      .join("\u0000");
    if (reportedCycles.has(key)) return;
    reportedCycles.add(key);
    issues.push({
      code: "dependency_cycle",
      taskId: canonicalNodes[0]!,
      cycle: [...canonicalNodes, canonicalNodes[0]!],
    });
  };

  const visit = (taskId: string): void => {
    const state = visitState.get(taskId);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = stack.lastIndexOf(taskId);
      reportCycle([...stack.slice(cycleStart), taskId]);
      return;
    }

    visitState.set(taskId, "visiting");
    stack.push(taskId);
    const task = taskById.get(taskId)!;
    for (const dependencyId of task.dependsOn ?? []) {
      if (dependencyId !== taskId && taskById.has(dependencyId)) visit(dependencyId);
    }
    stack.pop();
    visitState.set(taskId, "visited");
  };

  for (const taskId of taskById.keys()) visit(taskId);

  return { valid: issues.length === 0, issues };
}

export function assertValidTeamTaskGraph(tasks: readonly TeamTaskSpec[]): void {
  const validation = validateTeamTaskGraph(tasks);
  if (!validation.valid) throw new TeamTaskGraphValidationError(validation.issues);
}

/**
 * Build stable topological layers. Tasks in the same wave can run in parallel;
 * declaration order is retained within every wave.
 */
export function buildTeamTaskWaves(
  tasks: readonly TeamTaskSpec[],
): readonly (readonly TeamTaskSpec[])[] {
  assertValidTeamTaskGraph(tasks);

  const order = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingDependencies = new Map(
    tasks.map((task) => [task.id, (task.dependsOn ?? []).length]),
  );
  const dependants = new Map(tasks.map((task) => [task.id, [] as string[]]));

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      dependants.get(dependencyId)!.push(task.id);
    }
  }

  let ready = tasks.filter((task) => remainingDependencies.get(task.id) === 0);
  const waves: TeamTaskSpec[][] = [];

  while (ready.length > 0) {
    const wave = ready;
    waves.push(wave);
    const nextIds: string[] = [];

    for (const task of wave) {
      for (const dependantId of dependants.get(task.id)!) {
        const remaining = remainingDependencies.get(dependantId)! - 1;
        remainingDependencies.set(dependantId, remaining);
        if (remaining === 0) nextIds.push(dependantId);
      }
    }

    nextIds.sort((left, right) => order.get(left)! - order.get(right)!);
    ready = nextIds.map((taskId) => tasks[order.get(taskId)!]!);
  }

  return waves;
}
