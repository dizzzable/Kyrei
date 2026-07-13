import type {
  PipelineRunState,
  PipelineRunStatus,
  PipelineStageKind,
  PipelineStageState,
  PipelineStageStatus,
  PipelineTransitionInput,
  PipelineUncertaintyResolution,
} from "./types.js";

const RUN_TRANSITIONS: Readonly<Record<PipelineRunStatus, readonly PipelineRunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["paused", "budget_paused", "awaiting_approval", "blocked", "interrupted", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  budget_paused: ["running", "failed", "cancelled"],
  awaiting_approval: ["running", "blocked", "interrupted", "failed", "cancelled"],
  blocked: ["running", "interrupted", "failed", "cancelled"],
  interrupted: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const STAGE_TRANSITIONS: Readonly<
  Record<PipelineStageStatus, readonly PipelineStageStatus[]>
> = {
  pending: ["running", "awaiting_approval", "blocked", "skipped", "cancelled"],
  running: ["awaiting_approval", "blocked", "budget_paused", "interrupted", "uncertain", "completed", "failed", "cancelled"],
  awaiting_approval: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["running", "failed", "skipped", "cancelled"],
  budget_paused: ["running", "interrupted", "failed", "cancelled"],
  interrupted: ["running", "failed", "cancelled"],
  // An uncertain write can only leave this state through
  // resolveUncertainPipelineStage(), which requires a verifier-backed marker.
  uncertain: [],
  failed: ["running", "skipped", "cancelled"],
  completed: [],
  skipped: [],
  cancelled: [],
};

const TERMINAL_RUN_STATUSES = new Set<PipelineRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_STAGE_STATUSES = new Set<PipelineStageStatus>([
  "completed",
  "skipped",
  "cancelled",
]);

export class PipelineTransitionError extends Error {
  readonly entity: "run" | "stage";
  readonly entityId: string;
  readonly from: PipelineRunStatus | PipelineStageStatus;
  readonly to: PipelineRunStatus | PipelineStageStatus;

  constructor(
    entity: "run" | "stage",
    entityId: string,
    from: PipelineRunStatus | PipelineStageStatus,
    to: PipelineRunStatus | PipelineStageStatus,
  ) {
    super(`Illegal pipeline ${entity} transition for ${entityId}: ${from} -> ${to}`);
    this.name = "PipelineTransitionError";
    this.entity = entity;
    this.entityId = entityId;
    this.from = from;
    this.to = to;
  }
}

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must not be blank`);
}

function assertTimestamp(value: string, field: string): void {
  if (value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
}

function assertMonotonicTimestamp(previous: string, next: string): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new RangeError(`Transition timestamp ${next} precedes ${previous}`);
  }
}

function assertResolution(resolution: PipelineUncertaintyResolution): void {
  if (!/^[a-f0-9]{64}$/i.test(resolution.markerDigest)) {
    throw new TypeError("uncertainty resolution markerDigest must be a SHA-256 digest");
  }
  assertNonBlank(resolution.verifiedBy, "uncertainty resolution verifiedBy");
  if (!["retry", "applied", "abandoned"].includes(resolution.outcome)) {
    throw new TypeError("uncertainty resolution outcome is invalid");
  }
}

export function isTerminalRunStatus(status: PipelineRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isTerminalStageStatus(status: PipelineStageStatus): boolean {
  return TERMINAL_STAGE_STATUSES.has(status);
}

export function canTransitionRun(
  from: PipelineRunStatus,
  to: PipelineRunStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionStage(
  from: PipelineStageStatus,
  to: PipelineStageStatus,
): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

export function createPipelineRun(id: string, createdAt: string): PipelineRunState {
  assertNonBlank(id, "run id");
  assertTimestamp(createdAt, "createdAt");
  return {
    id,
    status: "queued",
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    transitions: [],
  };
}

export function createPipelineStage(
  id: string,
  runId: string,
  kind: PipelineStageKind,
  createdAt: string,
): PipelineStageState {
  assertNonBlank(id, "stage id");
  assertNonBlank(runId, "run id");
  assertTimestamp(createdAt, "createdAt");
  return {
    id,
    runId,
    kind,
    status: "pending",
    attempt: 0,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    transitions: [],
  };
}

export function transitionPipelineRun(
  run: PipelineRunState,
  to: PipelineRunStatus,
  input: PipelineTransitionInput,
): PipelineRunState {
  if (!canTransitionRun(run.status, to)) {
    throw new PipelineTransitionError("run", run.id, run.status, to);
  }
  assertTimestamp(input.at, "transition at");
  assertMonotonicTimestamp(run.updatedAt, input.at);

  return {
    ...run,
    status: to,
    revision: run.revision + 1,
    updatedAt: input.at,
    startedAt: run.startedAt ?? (to === "running" ? input.at : undefined),
    completedAt: isTerminalRunStatus(to) ? input.at : undefined,
    transitions: [
      ...run.transitions,
      { from: run.status, to, at: input.at, reason: input.reason },
    ],
  };
}

export function transitionPipelineStage(
  stage: PipelineStageState,
  to: PipelineStageStatus,
  input: PipelineTransitionInput,
): PipelineStageState {
  if (!canTransitionStage(stage.status, to)) {
    throw new PipelineTransitionError("stage", stage.id, stage.status, to);
  }
  assertTimestamp(input.at, "transition at");
  assertMonotonicTimestamp(stage.updatedAt, input.at);

  const beginsAttempt = to === "running" && stage.status !== "running" && stage.status !== "awaiting_approval";
  return {
    ...stage,
    status: to,
    attempt: stage.attempt + (beginsAttempt ? 1 : 0),
    revision: stage.revision + 1,
    updatedAt: input.at,
    startedAt: stage.startedAt ?? (to === "running" ? input.at : undefined),
    completedAt: isTerminalStageStatus(to) ? input.at : undefined,
    transitions: [
      ...stage.transitions,
      { from: stage.status, to, at: input.at, reason: input.reason },
    ],
  };
}

/**
 * Resolves an interrupted write only after the caller has verified a durable
 * receipt. Keeping this separate from the generic transition primitive makes
 * it impossible for schedulers to accidentally resurrect uncertain work.
 */
export function resolveUncertainPipelineStage(
  stage: PipelineStageState,
  resolution: PipelineUncertaintyResolution,
  input: PipelineTransitionInput,
): PipelineStageState {
  if (stage.status !== "uncertain") {
    throw new PipelineTransitionError("stage", stage.id, stage.status, "uncertain");
  }
  assertResolution(resolution);
  assertTimestamp(input.at, "transition at");
  assertMonotonicTimestamp(stage.updatedAt, input.at);

  const to: PipelineStageStatus = resolution.outcome === "retry"
    ? "interrupted"
    : resolution.outcome === "applied"
      ? "completed"
      : "failed";

  return {
    ...stage,
    status: to,
    revision: stage.revision + 1,
    updatedAt: input.at,
    completedAt: isTerminalStageStatus(to) ? input.at : undefined,
    uncertaintyResolution: { ...resolution },
    transitions: [
      ...stage.transitions,
      { from: "uncertain", to, at: input.at, reason: input.reason },
    ],
  };
}
