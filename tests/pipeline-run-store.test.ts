import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineRunStore } from "../core/pipeline-run-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "kyrei-pipeline-runs-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function input(runId = "run-one") {
  return {
    runId,
    pipelineId: "coding-org",
    definitionRevision: "rev-7",
    definitionDigest: "a".repeat(64),
    runtimeFingerprint: "b".repeat(64),
    workspaceBaselineDigest: "c".repeat(64),
    workspaceBaselineObservedAt: "2026-07-13T00:00:00.000Z",
    goal: "Ship a verified feature",
    workspace: join(tmpdir(), "kyrei-workspace"),
    attachedSessionIds: ["session-a"],
    stages: [
      { id: "research", kind: "research", metadata: { retry: { maxAttempts: 2 } } },
      { id: "approve", kind: "approval", dependsOn: ["research"] },
      { id: "implement", kind: "execute", dependsOn: ["approve"], writeCapable: true, metadata: { retry: { maxAttempts: 2 } } },
      { id: "verify", kind: "verify", dependsOn: ["implement"] },
    ],
    budget: {
      limits: {
        maxInputTokens: 20_000,
        maxOutputTokens: 20_000,
        maxTotalTokens: 20_000,
        maxCalls: 20,
        maxWallTimeMs: 1_000,
        maxRepairCycles: 2,
        maxAssistanceRequests: 3,
        maxConcurrency: 2,
        maxCostUsd: 1,
      },
      consumed: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        calls: 0,
        wallTimeMs: 0,
        repairCycles: 0,
        assistanceRequests: 0,
        costUsd: 0,
      },
      reserved: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        calls: 0,
        wallTimeMs: 0,
        repairCycles: 0,
        assistanceRequests: 0,
        costUsd: 0,
      },
      unmeteredCalls: 0,
    },
  };
}

function storeWithResolutionVerifier(dataDir: string) {
  const receipts = new WeakSet<object>();
  return {
    store: new PipelineRunStore({ dataDir, isVerifiedResolution: (marker) => receipts.has(marker as object) }),
    verify<T extends object>(marker: T): T {
      receipts.add(marker);
      return marker;
    },
  };
}

function artifactFor({
  runId,
  stageId,
  id = `artifact-${stageId}`,
  kind = "department",
  summary = "Official documentation checked",
}: {
  runId: string;
  stageId: string;
  id?: string;
  kind?: "department" | "action" | "verification" | "improvement" | "assistance";
  summary?: string;
}) {
  return {
    schemaVersion: 1 as const,
    id,
    kind,
    runId,
    stageId,
    producerId: "research-team",
    createdAt: "2026-07-13T00:00:00.000Z",
    summary,
    workspaceDigest: "c".repeat(64),
    inputDigests: [],
    assumptions: [],
    uncertainties: [],
    unchecked: [],
    provenance: {
      providerId: "test-provider",
      modelId: "test-model",
      policyDigest: "d".repeat(64),
    },
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerCalls: 0,
      durationMs: 0,
    },
    claims: [],
    evidence: [],
    checks: [],
    contradictions: [],
  };
}

async function advanceToWriter(store: PipelineRunStore, runId: string) {
  await store.updateStage(runId, "research", { status: "running" });
  await store.updateStage(runId, "research", { status: "completed" });
  await store.recordApproval(runId, { stageId: "approve", status: "approved", actor: "test-operator" });
  await store.updateStage(runId, "implement", { status: "running", workspaceDigestBefore: "c".repeat(64) });
}

describe("PipelineRunStore", () => {
  it("persists an immutable definition with serialized mutations, artifacts, approvals, sessions, and budget", async () => {
    const store = new PipelineRunStore({ dataDir: await root() });
    await store.create(input());
    await Promise.all([
      store.attachSession("run-one", "session-b"),
      store.attachSession("run-one", "session-b"),
      store.updateBudget("run-one", { consumed: { totalTokens: 120 } }),
    ]);
    await store.start("run-one");
    await store.updateStage("run-one", "research", { status: "running" });
    await store.recordArtifact("run-one", artifactFor({
      runId: "run-one",
      stageId: "research",
      id: "artifact-research",
    }));
    await store.updateStage("run-one", "research", { status: "completed" });
    await store.recordApproval("run-one", { id: "approval-1", stageId: "approve", status: "approved", actor: "orchestrator" });

    const state = await store.load("run-one");
    expect(state).toMatchObject({
      schemaVersion: 1,
      runId: "run-one",
      pipelineId: "coding-org",
      definitionRevision: "rev-7",
      status: "running",
      attachedSessionIds: ["session-a", "session-b"],
      budget: { consumed: { totalTokens: 120 } },
    });
    expect(state?.stages[0]).toMatchObject({ status: "completed", artifactIds: ["artifact-research"] });
    expect(state?.approvals).toHaveLength(1);
    await expect(store.updateBudget("run-one", { consumed: { totalTokens: 119 } }))
      .rejects.toThrow("pipeline_budget_non_monotonic");
    expect(() => store.updateBudget("run-one", { limits: { maxTotalTokens: 999_999 } } as never))
      .toThrow("pipeline_budget_limits_immutable");
    expect((await store.readJournal("run-one")).map((row: { sequence: number }) => row.sequence)).toEqual(
      Array.from({ length: state!.sequence }, (_, index) => index + 1),
    );
    expect(JSON.stringify(state)).not.toContain("definitionRevision\":\"anything-else");
  });

  it("validates integer usage and durably records actual budget overage", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("budget-overage-run"));

    await expect(store.updateBudget("budget-overage-run", {
      consumed: { inputTokens: 0.5 },
    })).rejects.toThrow("pipeline_budget_usage_invalid");
    await expect(store.updateBudget("budget-overage-run", {
      consumed: { calls: -1 },
    })).rejects.toThrow("pipeline_budget_usage_invalid");
    await expect(store.updateBudget("budget-overage-run", {
      consumed: { inputTokens: 11, outputTokens: 10, totalTokens: 20 },
    })).rejects.toThrow("pipeline_budget_total_invalid");

    const overdrawn = await store.updateBudget("budget-overage-run", {
      consumed: {
        inputTokens: 13_000,
        outputTokens: 12_000,
        totalTokens: 25_000,
        calls: 19,
        wallTimeMs: 1_250,
        repairCycles: 3,
        assistanceRequests: 5,
        costUsd: 1.25,
      },
      unmeteredCalls: 2,
    });
    expect(overdrawn.budget).toMatchObject({
      consumed: {
        inputTokens: 13_000,
        outputTokens: 12_000,
        totalTokens: 25_000,
        calls: 19,
        wallTimeMs: 1_250,
        repairCycles: 3,
        assistanceRequests: 5,
        costUsd: 1.25,
      },
      unmeteredCalls: 2,
      exhausted: true,
      overdrawn: true,
      overage: {
        totalTokens: 5_000,
        calls: 1,
        wallTimeMs: 250,
        repairCycles: 1,
        assistanceRequests: 2,
        costUsd: 0.25,
      },
    });
    expect(overdrawn.budget.exhaustedAt).toEqual(expect.any(String));
    expect(overdrawn.budget.overdrawnAt).toEqual(expect.any(String));

    const reloaded = await new PipelineRunStore({ dataDir }).load("budget-overage-run");
    expect(reloaded?.budget).toMatchObject({
      consumed: { totalTokens: 25_000, calls: 19 },
      exhausted: true,
      overdrawn: true,
      overage: {
        totalTokens: 5_000,
        calls: 1,
        wallTimeMs: 250,
        repairCycles: 1,
        assistanceRequests: 2,
        costUsd: 0.25,
      },
    });
    await expect(store.updateBudget("budget-overage-run", {
      consumed: { totalTokens: 24_999 },
    })).rejects.toThrow("pipeline_budget_non_monotonic");
  });

  it("persists distinct orchestration wait states with guarded return transitions", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    for (const status of ["awaiting_approval", "blocked"] as const) {
      const runId = `wait-${status}`;
      await store.create(input(runId));
      await store.start(runId);
      const waiting = await store.transition(runId, status, { reason: status });
      expect(waiting).toMatchObject({ status, lastTransition: { status } });
      expect((await new PipelineRunStore({ dataDir }).load(runId))?.status).toBe(status);
      const resumed = await store.transition(runId, "running", { reason: "condition-cleared" });
      expect(resumed.status).toBe("running");
    }
    await store.create(input("wait-budget-paused"));
    await store.start("wait-budget-paused");
    await store.transition("wait-budget-paused", "budget_paused", { reason: "pipeline_budget_exhausted" });
    await expect(store.transition("wait-budget-paused", "running"))
      .rejects.toThrow("pipeline_status_transition_invalid");
    await expect(store.resume("wait-budget-paused"))
      .rejects.toThrow("pipeline_resume_invalid");
    expect((await store.cancel("wait-budget-paused")).status).toBe("cancelled");

    await store.create(input("wait-budget-transition"));
    await store.start("wait-budget-transition");
    await store.transition("wait-budget-transition", "budget_paused");
    await expect(store.transition("wait-budget-transition", "awaiting_approval"))
      .rejects.toThrow("pipeline_status_transition_invalid");
    await store.transition("wait-blocked", "blocked");
    expect((await store.transition("wait-blocked", "failed")).status).toBe("failed");

    await store.create(input("stage-wait-states"));
    await store.start("stage-wait-states");
    expect((await store.updateStage("stage-wait-states", "research", { status: "blocked" })).stages[0].status)
      .toBe("blocked");
    await store.updateStage("stage-wait-states", "research", { status: "running" });
    expect((await store.updateStage("stage-wait-states", "research", { status: "budget_paused" })).stages[0].status)
      .toBe("budget_paused");
  });

  it("keeps terminal runs immutable and turns unsuccessful writer exits into uncertain state", async () => {
    const store = new PipelineRunStore({ dataDir: await root() });
    await store.create(input("terminal-guard-run"));
    await store.start("terminal-guard-run");
    await advanceToWriter(store, "terminal-guard-run");
    const uncertain = await store.updateStage("terminal-guard-run", "implement", { status: "failed" });
    expect(uncertain.stages.find((stage: { id: string }) => stage.id === "implement"))
      .toMatchObject({ status: "uncertain", uncertain: true });
    await expect(store.transition("terminal-guard-run", "failed"))
      .rejects.toThrow("pipeline_write_resolution_required");

    await store.create(input("immutable-terminal-run"));
    await store.start("immutable-terminal-run");
    await store.transition("immutable-terminal-run", "failed");
    await expect(store.attachSession("immutable-terminal-run", "late-session"))
      .rejects.toThrow("pipeline_run_terminal");
    await expect(store.recordApproval("immutable-terminal-run", { stageId: "research", status: "approved" }))
      .rejects.toThrow("pipeline_run_terminal");
    await expect(store.updateBudget("immutable-terminal-run", { consumed: { totalTokens: 999 } }))
      .rejects.toThrow("pipeline_run_terminal");
  });

  it("forbids skipping required work and persists verified completion receipt lineage", async () => {
    const dataDir = await root();
    const actionReceipts = new WeakSet<object>();
    const truthReceipts = new WeakSet<object>();
    const store = new PipelineRunStore({
      dataDir,
      isVerifiedActionReceipt: (receipt) => actionReceipts.has(receipt as object),
      isVerifiedTruthGate: (receipt) => truthReceipts.has(receipt as object),
    });
    const runInput = input("completion-lineage-run");
    runInput.stages = [
      ...runInput.stages,
      { id: "truth", kind: "truth-gate", dependsOn: ["verify"], metadata: { retry: { maxAttempts: 1 } } },
    ];
    await store.create(runInput);
    await store.start("completion-lineage-run");
    await store.updateStage("completion-lineage-run", "research", { status: "running" });
    await store.updateStage("completion-lineage-run", "research", { status: "completed" });
    await store.recordApproval("completion-lineage-run", {
      stageId: "approve",
      status: "approved",
      actor: "test-operator",
    });

    await expect(store.updateStage("completion-lineage-run", "implement", { status: "skipped" }))
      .rejects.toThrow("pipeline_stage_skip_forbidden");
    await expect(store.updateStage("completion-lineage-run", "verify", { status: "skipped" }))
      .rejects.toThrow("pipeline_stage_skip_forbidden");
    await expect(store.updateStage("completion-lineage-run", "truth", { status: "skipped" }))
      .rejects.toThrow("pipeline_stage_skip_forbidden");
    await expect(store.transition("completion-lineage-run", "completed"))
      .rejects.toThrow("pipeline_completion_gate_failed");

    const actionReceipt = {
      workspaceDigestBefore: "c".repeat(64),
      workspaceDigest: "d".repeat(64),
      observedAt: "2026-07-13T00:01:00.000Z",
    };
    actionReceipts.add(actionReceipt);
    await store.updateStage("completion-lineage-run", "implement", {
      status: "running",
      workspaceDigestBefore: "c".repeat(64),
    });
    await store.updateStage("completion-lineage-run", "implement", {
      status: "completed",
      actionReceipt,
    });
    const actionReceiptDigest = (await store.load("completion-lineage-run"))?.stages
      .find((stage: { id: string }) => stage.id === "implement")?.actionReceiptDigest;
    expect(actionReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
    await store.updateStage("completion-lineage-run", "verify", { status: "running" });
    await store.updateStage("completion-lineage-run", "verify", { status: "completed" });
    await store.updateStage("completion-lineage-run", "truth", { status: "running" });
    const truthReceipt = {
      workspaceDigest: "d".repeat(64),
      observedAt: "2026-07-13T00:02:00.000Z",
      evidenceIds: ["test-suite"],
      actionReceiptDigests: [actionReceiptDigest],
    };
    const wrongActionLineage = {
      ...truthReceipt,
      actionReceiptDigests: ["e".repeat(64)],
    };
    truthReceipts.add(wrongActionLineage);
    await expect(store.updateStage("completion-lineage-run", "truth", {
      status: "completed",
      truthGateReceipt: wrongActionLineage,
    })).rejects.toThrow("pipeline_truth_gate_receipt_invalid");
    truthReceipts.add(truthReceipt);
    await store.updateStage("completion-lineage-run", "truth", {
      status: "completed",
      truthGateReceipt: truthReceipt,
    });
    expect((await store.transition("completion-lineage-run", "completed")).status).toBe("completed");

    const reloaded = await new PipelineRunStore({ dataDir }).load("completion-lineage-run");
    expect(reloaded?.stages.find((stage: { id: string }) => stage.id === "implement")?.actionReceipt)
      .toMatchObject({ workspaceDigest: "d".repeat(64) });
    expect(reloaded?.stages.find((stage: { id: string }) => stage.id === "truth")?.truthGateReceipt)
      .toMatchObject({ workspaceDigest: "d".repeat(64), evidenceIds: ["test-suite"] });
    const auditEvents = await store.readJournal("completion-lineage-run");
    expect(auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ actionReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ truthGateReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      }),
    ]));
  });

  it("requires a canonical, stage-bound department artifact before completion", async () => {
    const store = new PipelineRunStore({ dataDir: await root() });
    const run = input("department-artifact-run");
    run.stages = [{ id: "research", kind: "department" }];
    await store.create(run);
    await store.start("department-artifact-run");
    await store.updateStage("department-artifact-run", "research", { status: "running" });

    await expect(store.updateStage("department-artifact-run", "research", { status: "completed" }))
      .rejects.toThrow("pipeline_department_artifact_required");
    await expect(store.recordArtifact("department-artifact-run", {
      id: "legacy-artifact",
      stageId: "research",
      summary: "Legacy shape without an evidence contract",
    })).rejects.toThrow("pipeline_artifact_invalid");
    await expect(store.recordArtifact("department-artifact-run", artifactFor({
      runId: "another-run",
      stageId: "research",
      id: "wrong-run",
    }))).rejects.toThrow("pipeline_artifact_lineage_invalid");

    const envelope = artifactFor({
      runId: "department-artifact-run",
      stageId: "research",
      id: "research-envelope",
    });
    await store.recordArtifact("department-artifact-run", envelope);
    await expect(store.recordArtifact("department-artifact-run", envelope))
      .rejects.toThrow("pipeline_artifact_exists");
    await expect(store.updateStage("department-artifact-run", "research", { status: "completed" }))
      .resolves.toMatchObject({
        stages: [expect.objectContaining({ id: "research", artifactIds: ["research-envelope"] })],
      });
  });

  it("reopens artifacts that preserve nonempty uncertainty and unchecked-work lists", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("artifact-lists-run"));
    await store.start("artifact-lists-run");
    await store.updateStage("artifact-lists-run", "research", { status: "running" });
    const artifact = artifactFor({
      runId: "artifact-lists-run",
      stageId: "research",
      id: "artifact-with-lists",
    });
    artifact.uncertainties = ["A deterministic verifier has not run yet."];
    artifact.unchecked = ["Workspace writes were intentionally not attempted."];
    await store.recordArtifact("artifact-lists-run", artifact);

    const reopened = await new PipelineRunStore({ dataDir }).load("artifact-lists-run");
    expect(reopened?.artifacts[0]).toMatchObject({
      id: "artifact-with-lists",
      uncertainties: artifact.uncertainties,
      unchecked: artifact.unchecked,
    });
  });

  it("atomically completes a running department with its canonical artifact", async () => {
    const store = new PipelineRunStore({ dataDir: await root() });
    const run = input("atomic-department-run");
    run.stages = [{ id: "research", kind: "department" }];
    await store.create(run);
    await store.start("atomic-department-run");
    await store.updateStage("atomic-department-run", "research", { status: "running" });

    const malformed = artifactFor({
      runId: "atomic-department-run",
      stageId: "research",
      id: "malformed-department-artifact",
      summary: "",
    });
    await expect(store.completeDepartmentWithArtifact("atomic-department-run", "research", malformed))
      .rejects.toThrow("pipeline_artifact_invalid");
    expect(await store.load("atomic-department-run")).toMatchObject({
      artifacts: [],
      stages: [expect.objectContaining({ id: "research", status: "running", artifactIds: [] })],
    });

    const completed = await store.completeDepartmentWithArtifact(
      "atomic-department-run",
      "research",
      artifactFor({
        runId: "atomic-department-run",
        stageId: "research",
        id: "atomic-department-artifact",
      }),
    );
    expect(completed.stages).toEqual([
      expect.objectContaining({ id: "research", status: "completed", artifactIds: ["atomic-department-artifact"] }),
    ]);
    expect(completed.artifacts).toEqual([expect.objectContaining({ id: "atomic-department-artifact" })]);
    expect((await store.readJournal("atomic-department-run")).at(-1)).toMatchObject({
      type: "department.completed",
      payload: { stageId: "research", artifactId: "atomic-department-artifact" },
    });
  });

  it("rebuilds an equal-sequence mismatched snapshot and ignores a partial journal tail", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("journal-run"));
    const latest = await store.attachSession("journal-run", "from-journal");
    await writeFile(store.pathFor("journal-run"), JSON.stringify({
      ...latest,
      attachedSessionIds: ["session-a", "tampered-at-same-sequence"],
    }), "utf8");
    await writeFile(store.journalPathFor("journal-run"), `${await readFile(store.journalPathFor("journal-run"), "utf8")}{broken`, "utf8");

    const restarted = new PipelineRunStore({ dataDir });
    const recovered = await restarted.load("journal-run");
    expect(recovered?.attachedSessionIds).toContain("from-journal");
    expect(recovered?.attachedSessionIds).not.toContain("tampered-at-same-sequence");
    expect(JSON.parse(await readFile(restarted.pathFor("journal-run"), "utf8")).sequence).toBe(recovered?.sequence);
  });

  it("recovers a valid-JSON partial snapshot but fails closed on a corrupted committed event", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("valid-json-corruption-run"));
    await store.attachSession("valid-json-corruption-run", "journal-session");
    await writeFile(store.pathFor("valid-json-corruption-run"), JSON.stringify({
      schemaVersion: 1,
      runId: "valid-json-corruption-run",
      sequence: 2,
      status: "running",
    }), "utf8");

    const repaired = await new PipelineRunStore({ dataDir }).load("valid-json-corruption-run");
    expect(repaired?.attachedSessionIds).toContain("journal-session");

    const raw = await readFile(store.journalPathFor("valid-json-corruption-run"), "utf8");
    const lines = raw.split("\n");
    const eventIndex = lines.findIndex((line) => line.includes("session.attached"));
    const event = JSON.parse(lines[eventIndex]);
    event.payload = { sessionId: "tampered-without-a-new-payload-hash" };
    lines[eventIndex] = JSON.stringify(event);
    await writeFile(store.journalPathFor("valid-json-corruption-run"), lines.join("\n"), "utf8");
    await writeFile(store.pathFor("valid-json-corruption-run"), "{\"schemaVersion\":1}", "utf8");

    await expect(new PipelineRunStore({ dataDir }).load("valid-json-corruption-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");
  });

  it("fails closed when committed journal history is deleted or truncated", async () => {
    const deletedDir = await root();
    const deletedStore = new PipelineRunStore({ dataDir: deletedDir });
    await deletedStore.create(input("deleted-journal-run"));
    await rm(deletedStore.journalPathFor("deleted-journal-run"));
    await expect(new PipelineRunStore({ dataDir: deletedDir }).load("deleted-journal-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");
    await expect(new PipelineRunStore({ dataDir: deletedDir }).list())
      .rejects.toThrow("pipeline_run_state_corrupt");
    await expect(new PipelineRunStore({ dataDir: deletedDir }).readJournal("deleted-journal-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");
    await rm(deletedStore.headPathFor("deleted-journal-run"));
    await expect(new PipelineRunStore({ dataDir: deletedDir }).load("deleted-journal-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");
    await expect(new PipelineRunStore({ dataDir: deletedDir }).readJournal("deleted-journal-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");

    const truncatedDir = await root();
    const truncatedStore = new PipelineRunStore({ dataDir: truncatedDir });
    await truncatedStore.create(input("truncated-journal-run"));
    await truncatedStore.attachSession("truncated-journal-run", "persisted-session");
    const journalPath = truncatedStore.journalPathFor("truncated-journal-run");
    const journal = await readFile(journalPath, "utf8");
    await writeFile(journalPath, journal.slice(0, Math.floor(journal.length / 2)), "utf8");
    await expect(new PipelineRunStore({ dataDir: truncatedDir }).load("truncated-journal-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");
    await expect(new PipelineRunStore({ dataDir: truncatedDir }).readJournal("truncated-journal-run"))
      .rejects.toThrow("pipeline_run_state_corrupt");
  });

  it("keeps delta journal growth near-linear and bounds paginated reads", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("journal-growth-run"));
    const sessionId = (index: number) => `${String(index).padStart(3, "0")}-${"x".repeat(250)}`;
    for (let index = 1; index <= 20; index += 1) {
      await store.attachSession("journal-growth-run", sessionId(index));
    }
    const smallJournalBytes = (await stat(store.journalPathFor("journal-growth-run"))).size;
    for (let index = 21; index <= 120; index += 1) {
      await store.attachSession("journal-growth-run", sessionId(index));
    }
    const largeJournalBytes = (await stat(store.journalPathFor("journal-growth-run"))).size;
    expect(largeJournalBytes).toBeLessThan(smallJournalBytes * 9);

    const firstPage = await store.readJournal("journal-growth-run");
    expect(firstPage).toHaveLength(100);
    expect(firstPage.map((event: { sequence: number }) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(firstPage.every((event: object) => (
      !Object.hasOwn(event, "state")
      && !Object.hasOwn(event, "checkpoint")
      && !Object.hasOwn(event, "delta")
    ))).toBe(true);
    expect(firstPage[0]).toMatchObject({
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(firstPage.at(-1)).toMatchObject({
      page: { hasMore: true, nextAfterSequence: 100, limit: 100 },
    });

    const nextPage = await store.readJournal("journal-growth-run", { afterSequence: 100, limit: 7 });
    expect(nextPage.map((event: { sequence: number }) => event.sequence)).toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(nextPage.at(-1)).toMatchObject({ page: { hasMore: true, nextAfterSequence: 107, limit: 7 } });
    await expect(store.readJournal("journal-growth-run", { limit: 1_001 }))
      .rejects.toThrow("pipeline_journal_page_invalid");
  });

  it("serializes mutations across separately constructed store instances", async () => {
    const dataDir = await root();
    const first = new PipelineRunStore({ dataDir });
    const second = new PipelineRunStore({ dataDir });
    await first.create(input("multi-instance-run"));
    await Promise.all([first.load("multi-instance-run"), second.load("multi-instance-run")]);
    await Promise.all([
      first.attachSession("multi-instance-run", "session-from-a"),
      second.attachSession("multi-instance-run", "session-from-b"),
    ]);
    const state = await first.load("multi-instance-run");
    expect(state?.attachedSessionIds).toEqual(expect.arrayContaining(["session-from-a", "session-from-b"]));
    const journal = await first.readJournal("multi-instance-run");
    expect(new Set(journal.map((row: { sequence: number }) => row.sequence)).size).toBe(journal.length);
  });

  it("does not let a repair reader truncate an in-flight journal append", async () => {
    const dataDir = await root();
    let announceAppend!: () => void;
    let releaseWriter!: () => void;
    const appendReached = new Promise<void>((resolve) => { announceAppend = resolve; });
    const writerReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = new PipelineRunStore({
      dataDir,
      onJournalAppend: async ({ sequence }: { sequence: number }) => {
        if (sequence !== 2) return;
        announceAppend();
        await writerReleased;
      },
    });
    await writer.create(input("append-repair-race-run"));

    const write = writer.start("append-repair-race-run");
    await appendReached;
    const reader = new PipelineRunStore({ dataDir });
    const read = reader.load("append-repair-race-run");
    expect(await Promise.race([
      read.then(() => "read-completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("reader-waiting-on-run-lock"), 40)),
    ])).toBe("reader-waiting-on-run-lock");

    releaseWriter();
    const [written, loaded] = await Promise.all([write, read]);
    expect(written).toMatchObject({ status: "running", sequence: 2 });
    expect(loaded).toMatchObject({ status: "running", sequence: 2 });
    expect((await reader.readJournal("append-repair-race-run")).map((event: { sequence: number }) => event.sequence))
      .toEqual([1, 2]);
  });

  it("marks an in-flight write uncertain after restart and requires an explicit resolution before resume", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("interrupted-run"));
    await store.start("interrupted-run");
    await advanceToWriter(store, "interrupted-run");

    const verified = storeWithResolutionVerifier(dataDir);
    const restarted = verified.store;
    expect(await restarted.recoverInterrupted()).toEqual(["interrupted-run"]);
    expect(await restarted.load("interrupted-run")).toMatchObject({
      status: "interrupted",
      stages: expect.arrayContaining([expect.objectContaining({ id: "implement", status: "uncertain", uncertain: true })]),
    });
    await expect(restarted.resume("interrupted-run")).rejects.toThrow("pipeline_write_resolution_required");

    const resumed = await restarted.resume("interrupted-run", {
      resolutionMarker: verified.verify({ outcome: "retry", evidence: "diff and git status show no applied write" }),
    });
    expect(resumed.status).toBe("running");
    expect(resumed.stages.find((stage: { id: string }) => stage.id === "implement")).toMatchObject({
      status: "interrupted",
      uncertain: false,
      resolution: { outcome: "retry" },
    });
  });

  it("recovers a writer left active by a paused mission as uncertain after restart", async () => {
    const dataDir = await root();
    const initial = new PipelineRunStore({ dataDir });
    await initial.create(input("paused-writer-run"));
    await initial.start("paused-writer-run");
    await advanceToWriter(initial, "paused-writer-run");
    const paused = await initial.pause("paused-writer-run", { reason: "operator pause" });
    expect(paused).toMatchObject({
      status: "paused",
      stages: expect.arrayContaining([
        expect.objectContaining({ id: "implement", status: "running" }),
      ]),
    });

    const verified = storeWithResolutionVerifier(dataDir);
    expect(await verified.store.recoverInterrupted()).toContain("paused-writer-run");
    expect(await verified.store.load("paused-writer-run")).toMatchObject({
      status: "interrupted",
      interruption: { reason: "gateway_restart", previousStatus: "paused" },
      stages: expect.arrayContaining([
        expect.objectContaining({ id: "implement", status: "uncertain", uncertain: true }),
      ]),
    });
    await expect(verified.store.resume("paused-writer-run"))
      .rejects.toThrow("pipeline_write_resolution_required");
    await expect(verified.store.resume("paused-writer-run", {
      resolutionMarker: verified.verify({ outcome: "retry", evidence: "workspace unchanged" }),
    })).resolves.toMatchObject({
      status: "running",
      stages: expect.arrayContaining([
        expect.objectContaining({ id: "implement", status: "interrupted", uncertain: false }),
      ]),
    });
  });

  it("allows exactly one action attempt for each verified crash retry outcome", async () => {
    const dataDir = await root();
    const initial = new PipelineRunStore({ dataDir });
    const runInput = input("verified-crash-retry-run");
    runInput.stages = runInput.stages.map((stage) => (
      stage.id === "implement"
        ? { ...stage, metadata: { retry: { maxAttempts: 1 } } }
        : stage
    ));
    await initial.create(runInput);
    await initial.start("verified-crash-retry-run");
    await advanceToWriter(initial, "verified-crash-retry-run");

    const verified = storeWithResolutionVerifier(dataDir);
    const restarted = verified.store;
    await restarted.recoverInterrupted();
    await restarted.resume("verified-crash-retry-run", {
      resolutionMarker: verified.verify({ outcome: "retry", evidence: "workspace is unchanged" }),
    });

    const retried = await restarted.updateStage("verified-crash-retry-run", "implement", {
      status: "running",
      workspaceDigestBefore: "c".repeat(64),
    });
    expect(retried.stages.find((stage: { id: string }) => stage.id === "implement")).toMatchObject({
      status: "running",
      attempts: 2,
      resolution: {
        outcome: "retry",
        retryAuthorizedAt: expect.any(String),
        retryConsumedAt: expect.any(String),
      },
    });
    await expect(restarted.updateStage("verified-crash-retry-run", "implement", {
      metadata: { retry: { maxAttempts: 99 } },
    })).rejects.toThrow("pipeline_stage_retry_immutable");

    await restarted.updateStage("verified-crash-retry-run", "implement", { status: "failed" });
    await expect(restarted.updateStage("verified-crash-retry-run", "implement", {
      status: "running",
      workspaceDigestBefore: "c".repeat(64),
    })).rejects.toThrow("pipeline_write_resolution_required");
    await expect(restarted.updateStage("verified-crash-retry-run", "implement", {
      status: "running",
      workspaceDigestBefore: "c".repeat(64),
      resolutionMarker: { outcome: "retry", evidence: "not branded by the verifier" },
    })).rejects.toThrow("pipeline_write_resolution_unverified");

    await restarted.updateStage("verified-crash-retry-run", "implement", {
      status: "failed",
      resolutionMarker: verified.verify({ outcome: "abandoned", evidence: "operator abandoned write" }),
    });
    await expect(restarted.updateStage("verified-crash-retry-run", "implement", {
      status: "running",
      workspaceDigestBefore: "c".repeat(64),
    })).rejects.toThrow("pipeline_write_resolution_outcome_invalid");
  });

  it("preserves an awaiting approval across restart and rejects generic approval bypass", async () => {
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir });
    await store.create(input("approval-recovery-run"));
    await store.start("approval-recovery-run");
    await store.updateStage("approval-recovery-run", "research", { status: "running" });
    await store.updateStage("approval-recovery-run", "research", { status: "completed" });
    await expect(store.updateStage("approval-recovery-run", "approve", { status: "running" }))
      .rejects.toThrow("pipeline_approval_api_required");
    await store.recordApproval("approval-recovery-run", {
      id: "approval-request",
      stageId: "approve",
      status: "requested",
      actor: "orchestrator",
    });

    const restarted = new PipelineRunStore({ dataDir });
    await restarted.recoverInterrupted();
    const resumed = await restarted.resume("approval-recovery-run");
    expect(resumed.stages.find((stage: { id: string }) => stage.id === "approve"))
      .toMatchObject({ status: "awaiting_approval" });
    const approved = await restarted.recordApproval("approval-recovery-run", {
      id: "approval-decision",
      stageId: "approve",
      status: "approved",
      actor: "local-operator",
    });
    expect(approved.stages.find((stage: { id: string }) => stage.id === "approve"))
      .toMatchObject({ status: "completed" });
    await expect(restarted.recordApproval("approval-recovery-run", {
      id: "contradictory-decision",
      stageId: "approve",
      status: "rejected",
      actor: "local-operator",
    })).rejects.toThrow("pipeline_approval_transition_invalid");
  });

  it("keeps a cancelled in-flight write resumable as interrupted until its outcome is resolved", async () => {
    const verified = storeWithResolutionVerifier(await root());
    const store = verified.store;
    await store.create(input("cancel-write-run"));
    await store.start("cancel-write-run");
    await advanceToWriter(store, "cancel-write-run");

    const cancelled = await store.cancel("cancel-write-run", { reason: "operator stop" });
    expect(cancelled).toMatchObject({
      status: "interrupted",
      finishedAt: null,
      interruption: { reason: "cancelled_during_write" },
      stages: expect.arrayContaining([
        expect.objectContaining({ id: "implement", status: "uncertain", uncertain: true }),
      ]),
    });
    await expect(store.resume("cancel-write-run")).rejects.toThrow("pipeline_write_resolution_required");
  });

  it("rejects illegal stage resurrection and binds uncertain resolution outcomes to the requested state", async () => {
    const verified = storeWithResolutionVerifier(await root());
    const store = verified.store;
    await store.create(input("stage-gate-run"));
    await store.start("stage-gate-run");
    await store.updateStage("stage-gate-run", "research", { status: "running" });
    await store.updateStage("stage-gate-run", "research", { status: "completed" });
    await expect(store.updateStage("stage-gate-run", "research", { status: "running" }))
      .rejects.toThrow("pipeline_stage_transition_invalid");

    await store.recordApproval("stage-gate-run", { stageId: "approve", status: "approved", actor: "test-operator" });
    await store.updateStage("stage-gate-run", "implement", { status: "running", workspaceDigestBefore: "c".repeat(64) });
    await store.updateStage("stage-gate-run", "implement", { status: "uncertain" });
    await expect(store.updateStage("stage-gate-run", "implement", { status: "completed" }))
      .rejects.toThrow("pipeline_write_resolution_required");
    await expect(store.updateStage("stage-gate-run", "implement", {
      status: "completed",
      resolutionMarker: verified.verify({ outcome: "retry", evidence: "workspace unchanged" }),
    })).rejects.toThrow("pipeline_write_resolution_outcome_invalid");
    await expect(store.updateStage("stage-gate-run", "implement", {
      status: "completed",
      resolutionMarker: verified.verify({ outcome: "applied", evidence: "postcondition digest" }),
    })).resolves.toMatchObject({
      stages: expect.arrayContaining([
        expect.objectContaining({ id: "implement", status: "completed", uncertain: false }),
      ]),
    });
    await expect(store.updateStage("stage-gate-run", "implement", {
      status: "running",
      workspaceDigestBefore: "c".repeat(64),
    })).rejects.toThrow("pipeline_stage_transition_invalid");
  });

  it("redacts credential fields, token-shaped text, and exact runtime secrets from snapshot and journal", async () => {
    const dataDir = await root();
    const exact = "opaque-runtime-provider-credential";
    const store = new PipelineRunStore({ dataDir, getSensitiveValues: () => [exact] });
    await store.create({
      ...input("secret-run"),
      goal: `Do not persist ${exact} or sk-ABCDEFGHIJKLMNOPQRSTUVWX`,
      budget: { apiKey: "plain-key", note: exact },
    });
    await expect(store.recordArtifact("secret-run", artifactFor({
      runId: "secret-run",
      stageId: "research",
      summary: `Bearer hidden-bearer-token and ${exact}`,
    }))).rejects.toThrow("pipeline_artifact_sensitive_value");

    const raw = `${await readFile(store.pathFor("secret-run"), "utf8")}\n${await readFile(store.journalPathFor("secret-run"), "utf8")}`;
    expect(raw).not.toMatch(/opaque-runtime-provider-credential|ABCDEFGHIJKLMNOPQRSTUVWX|hidden-bearer-token|plain-key/);
    expect(raw).toContain("[REDACTED]");
  });

  it("redacts caller-supplied pause and cancel details before persisting a snapshot", async () => {
    const dataDir = await root();
    const exact = "transition-only-runtime-secret";
    const store = new PipelineRunStore({ dataDir, getSensitiveValues: () => [exact] });
    await store.create(input("transition-secret-run"));
    await store.start("transition-secret-run");
    const paused = await store.pause("transition-secret-run", { reason: `pause ${exact}` });
    expect(paused.lastTransition).toMatchObject({
      status: "paused",
      details: { reason: "pause [REDACTED]" },
    });
    await store.resume("transition-secret-run");
    const cancelled = await store.cancel("transition-secret-run", { reason: `cancel ${exact}` });
    expect(cancelled.lastTransition).toMatchObject({
      status: "cancelled",
      details: { reason: "cancel [REDACTED]", cancelRequested: true },
    });

    const raw = `${await readFile(store.pathFor("transition-secret-run"), "utf8")}\n${await readFile(store.journalPathFor("transition-secret-run"), "utf8")}`;
    expect(raw).not.toContain(exact);
  });

  it("never rewrites structural identifiers when a credential equals an id", async () => {
    const store = new PipelineRunStore({
      dataDir: await root(),
      getSensitiveValues: () => ["research"],
    });
    const state = await store.create(input("structural-redaction-run"));
    expect(state.stages.map((stage: { id: string }) => stage.id)).toContain("research");
    await store.start("structural-redaction-run");
    await store.updateStage("structural-redaction-run", "research", { status: "running" });
  });

  it("redacts exact credentials beyond the old 512-value boundary", async () => {
    const secrets = Array.from({ length: 513 }, (_, index) => `opaque-secret-${String(index).padStart(4, "0")}`);
    const dataDir = await root();
    const store = new PipelineRunStore({ dataDir, getSensitiveValues: () => secrets });
    await store.create({
      ...input("many-secret-run"),
      goal: `Do not persist ${secrets.at(-1)}`,
    });
    expect(await readFile(store.pathFor("many-secret-run"), "utf8")).not.toContain(secrets.at(-1));
  });
});
