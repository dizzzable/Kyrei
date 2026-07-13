import { describe, expect, it } from "vitest";
import {
  PipelineTransitionError,
  canTransitionRun,
  canTransitionStage,
  createPipelineRun,
  createPipelineStage,
  isTerminalRunStatus,
  isTerminalStageStatus,
  resolveUncertainPipelineStage,
  transitionPipelineRun,
  transitionPipelineStage,
} from "./state-machine.js";

const T0 = "2026-07-13T10:00:00.000Z";
const T1 = "2026-07-13T10:01:00.000Z";
const T2 = "2026-07-13T10:02:00.000Z";
const T3 = "2026-07-13T10:03:00.000Z";

describe("pipeline run state machine", () => {
  it("records a legal lifecycle without mutating previous states", () => {
    const created = createPipelineRun("run-1", T0);
    const running = transitionPipelineRun(created, "running", { at: T1 });
    const completed = transitionPipelineRun(running, "completed", {
      at: T2,
      reason: "truth gate accepted",
    });

    expect(created).toMatchObject({ status: "queued", revision: 0 });
    expect(running).toMatchObject({
      status: "running",
      revision: 1,
      startedAt: T1,
      completedAt: undefined,
    });
    expect(completed).toMatchObject({
      status: "completed",
      revision: 2,
      startedAt: T1,
      completedAt: T2,
    });
    expect(completed.transitions).toEqual([
      { from: "queued", to: "running", at: T1, reason: undefined },
      {
        from: "running",
        to: "completed",
        at: T2,
        reason: "truth gate accepted",
      },
    ]);
  });

  it("supports approval and blocked resumptions but keeps terminal states closed", () => {
    let run = transitionPipelineRun(createPipelineRun("run-1", T0), "running", {
      at: T1,
    });
    run = transitionPipelineRun(run, "awaiting_approval", { at: T2 });
    expect(canTransitionRun(run.status, "running")).toBe(true);
    run = transitionPipelineRun(run, "blocked", { at: T3 });
    expect(canTransitionRun(run.status, "running")).toBe(true);

    const cancelled = transitionPipelineRun(run, "cancelled", { at: T3 });
    expect(isTerminalRunStatus(cancelled.status)).toBe(true);
    expect(() =>
      transitionPipelineRun(cancelled, "running", { at: T3 }),
    ).toThrow(PipelineTransitionError);
  });

  it("rejects illegal and temporally regressive transitions", () => {
    const created = createPipelineRun("run-1", T1);
    expect(() =>
      transitionPipelineRun(created, "completed", { at: T2 }),
    ).toThrowError(/queued -> completed/);

    const running = transitionPipelineRun(created, "running", { at: T2 });
    expect(() =>
      transitionPipelineRun(running, "failed", { at: T0 }),
    ).toThrowError(RangeError);
  });
});

describe("pipeline stage state machine", () => {
  it("counts attempts whenever queued or failed work begins execution", () => {
    let stage = createPipelineStage("execute-1", "run-1", "action", T0);
    stage = transitionPipelineStage(stage, "running", { at: T1 });
    stage = transitionPipelineStage(stage, "failed", { at: T2 });
    stage = transitionPipelineStage(stage, "running", { at: T3 });

    expect(stage.attempt).toBe(2);
    expect(stage.startedAt).toBe(T1);
    expect(stage.completedAt).toBeUndefined();
  });

  it("does not count an approval resume as a new attempt", () => {
    let stage = createPipelineStage("plan-1", "run-1", "department", T0);
    stage = transitionPipelineStage(stage, "running", { at: T1 });
    stage = transitionPipelineStage(stage, "awaiting_approval", { at: T2 });
    stage = transitionPipelineStage(stage, "completed", { at: T3 });

    expect(stage.attempt).toBe(1);
    expect(isTerminalStageStatus(stage.status)).toBe(true);
  });

  it("allows blocked work to resume and closes completed stages", () => {
    let stage = createPipelineStage("research-1", "run-1", "department", T0);
    stage = transitionPipelineStage(stage, "blocked", { at: T2 });
    stage = transitionPipelineStage(stage, "running", { at: T3 });
    stage = transitionPipelineStage(stage, "completed", { at: T3 });

    expect(isTerminalStageStatus(stage.status)).toBe(true);
    expect(stage.completedAt).toBe(T3);
    expect(() =>
      transitionPipelineStage(stage, "running", { at: T3 }),
    ).toThrow(PipelineTransitionError);
  });

  it("keeps budget pause, approval wait, blocked, interrupted, and uncertain distinct", () => {
    const runningRun = transitionPipelineRun(createPipelineRun("run-2", T0), "running", { at: T1 });
    for (const status of ["paused", "budget_paused", "awaiting_approval", "blocked", "interrupted"] as const) {
      expect(transitionPipelineRun(runningRun, status, { at: T2 }).status).toBe(status);
    }

    const runningStage = transitionPipelineStage(
      createPipelineStage("action-2", "run-2", "action", T0),
      "running",
      { at: T1 },
    );
    for (const status of ["budget_paused", "blocked", "interrupted", "uncertain"] as const) {
      expect(transitionPipelineStage(runningStage, status, { at: T2 }).status).toBe(status);
    }
  });

  it("requires a verified uncertainty receipt instead of allowing generic resurrection", () => {
    const uncertain = transitionPipelineStage(
      transitionPipelineStage(
        createPipelineStage("write-1", "run-2", "action", T0),
        "running",
        { at: T1 },
      ),
      "uncertain",
      { at: T2 },
    );

    expect(canTransitionStage("uncertain", "running")).toBe(false);
    expect(() => transitionPipelineStage(uncertain, "running", { at: T3 }))
      .toThrow(PipelineTransitionError);

    const resolved = resolveUncertainPipelineStage(uncertain, {
      markerDigest: "a".repeat(64),
      verifiedBy: "workspace-receipt-verifier",
      outcome: "retry",
    }, { at: T3, reason: "verified no-write outcome" });

    expect(resolved).toMatchObject({
      status: "interrupted",
      uncertaintyResolution: {
        markerDigest: "a".repeat(64),
        verifiedBy: "workspace-receipt-verifier",
        outcome: "retry",
      },
    });
    expect(() => resolveUncertainPipelineStage(uncertain, {
      markerDigest: "not-a-digest",
      verifiedBy: "workspace-receipt-verifier",
      outcome: "retry",
    }, { at: T3 })).toThrow(TypeError);
  });
});
