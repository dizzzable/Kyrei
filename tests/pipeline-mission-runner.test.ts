import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PipelineMissionRunner } from "../core/pipeline-mission-runner.js";
import { PipelineRunStore } from "../core/pipeline-run-store.js";
import { WorkspaceLeaseStore } from "../core/workspace-lease-store.js";

const roots: string[] = [];
const BASELINE = "c".repeat(64);
const AFTER_ACTION = "d".repeat(64);

async function root() {
  const value = await mkdtemp(join(tmpdir(), "kyrei-pipeline-runner-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runInput(runId: string, workspace: string, stages: unknown[]) {
  return {
    runId,
    pipelineId: "coding-org",
    definitionRevision: "rev-1",
    definitionDigest: "a".repeat(64),
    runtimeFingerprint: "b".repeat(64),
    workspaceBaselineDigest: BASELINE,
    workspaceBaselineObservedAt: "2026-07-13T00:00:00.000Z",
    goal: "Build a verified result",
    workspace,
    stages,
    budget: {
      limits: {
        maxInputTokens: 100_000,
        maxOutputTokens: 100_000,
        maxTotalTokens: 100_000,
        maxCalls: 100,
        maxCostUsd: 100,
        maxWallTimeMs: 60_000,
        maxRepairCycles: 3,
        maxAssistanceRequests: 3,
        maxConcurrency: 2,
      },
      consumed: {},
      reserved: {},
      unmeteredCalls: 0,
    },
  };
}

function departmentArtifact(runId: string, stageId: string, workspaceDigest = BASELINE) {
  return {
    schemaVersion: 1 as const,
    id: `artifact-${stageId}`,
    kind: "department" as const,
    runId,
    stageId,
    producerId: `${stageId}-team`,
    createdAt: "2026-07-13T00:00:00.000Z",
    summary: `${stageId} completed with evidence`,
    workspaceDigest,
    inputDigests: [],
    assumptions: [],
    uncertainties: [],
    unchecked: [],
    provenance: {
      providerId: "test-provider",
      modelId: "test-model",
      policyDigest: "e".repeat(64),
    },
    metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, providerCalls: 0, durationMs: 0 },
    claims: [],
    evidence: [],
    checks: [],
    contradictions: [],
  };
}

describe("PipelineMissionRunner", () => {
  it("runs ready departments in dependency order and hands off only persisted artifacts", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    await store.create(runInput("department-run", workspace, [
      { id: "research", kind: "department" },
      { id: "plan", kind: "department", dependsOn: ["research"] },
    ]));
    await store.start("department-run");

    const calls: Array<{ stageId: string; dependencyArtifacts: Record<string, unknown[]> }> = [];
    const runner = new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async ({ run, stage, dependencyArtifacts }) => {
        calls.push({ stageId: stage.id, dependencyArtifacts });
        return departmentArtifact(run.runId, stage.id);
      },
    });

    const result = await runner.advance("department-run");
    expect(result.outcome).toBe("completed");
    expect(calls.map((call) => call.stageId)).toEqual(["research", "plan"]);
    expect(calls[0]?.dependencyArtifacts).toEqual({});
    expect(calls[1]?.dependencyArtifacts.research).toEqual([
      expect.objectContaining({ id: "artifact-research", stageId: "research" }),
    ]);
    expect((await store.load("department-run"))?.artifacts.map((artifact: { id: string }) => artifact.id))
      .toEqual(["artifact-research", "artifact-plan"]);
  });

  it("atomically charges a department before pausing the mission at its next exhausted budget gate", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const payload = runInput("budgeted-department-run", workspace, [
      { id: "research", kind: "department" },
      { id: "plan", kind: "department", dependsOn: ["research"] },
    ]);
    payload.budget.limits.maxCalls = 1;
    payload.budget.limits.maxTotalTokens = 3;
    const store = new PipelineRunStore({ dataDir });
    await store.create(payload);
    await store.start("budgeted-department-run");

    const calls: string[] = [];
    const result = await new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async ({ run, stage }) => {
        calls.push(stage.id);
        const artifact = departmentArtifact(run.runId, stage.id);
        artifact.metrics = {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          providerCalls: 1,
          durationMs: 25,
        };
        return artifact;
      },
    }).advance("budgeted-department-run");

    expect(result.outcome).toBe("budget_paused");
    expect(calls).toEqual(["research"]);
    expect(await store.load("budgeted-department-run")).toMatchObject({
      status: "budget_paused",
      artifacts: [expect.objectContaining({ id: "artifact-research" })],
      budget: {
        consumed: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          calls: 1,
          wallTimeMs: 25,
        },
        exhausted: true,
      },
      stages: [
        expect.objectContaining({ id: "research", status: "completed" }),
        expect.objectContaining({ id: "plan", status: "pending" }),
      ],
    });
  });

  it("charges opaque Team calls once through the unmetered budget without inventing token usage", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const payload = runInput("unmetered-team-run", workspace, [
      { id: "research", kind: "department" },
      { id: "plan", kind: "department", dependsOn: ["research"] },
    ]);
    payload.budget.limits.maxCalls = 2;
    const store = new PipelineRunStore({ dataDir });
    await store.create(payload);
    await store.start("unmetered-team-run");

    const calls: string[] = [];
    const result = await new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async ({ run, stage }) => {
        calls.push(stage.id);
        return {
          artifact: departmentArtifact(run.runId, stage.id),
          budgetMetrics: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            providerCalls: 2,
            unmeteredProviderCalls: 2,
            durationMs: 31,
            costUsd: 0,
          },
        };
      },
    }).advance("unmetered-team-run");

    expect(result.outcome).toBe("budget_paused");
    expect(calls).toEqual(["research"]);
    expect(await store.load("unmetered-team-run")).toMatchObject({
      status: "budget_paused",
      budget: {
        consumed: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          calls: 0,
          wallTimeMs: 31,
          costUsd: 0,
        },
        unmeteredCalls: 2,
        exhausted: true,
      },
      stages: [
        expect.objectContaining({ id: "research", status: "completed" }),
        expect.objectContaining({ id: "plan", status: "pending" }),
      ],
    });
  });

  it("fails closed instead of undercharging malformed reported Team metrics", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    await store.create(runInput("invalid-team-metrics", workspace, [{ id: "research", kind: "department" }]));
    await store.start("invalid-team-metrics");

    const result = await new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async ({ run, stage }) => ({
        artifact: departmentArtifact(run.runId, stage.id),
        budgetMetrics: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          providerCalls: 1,
          unmeteredProviderCalls: 2,
          durationMs: 1,
        },
      }),
    }).advance("invalid-team-metrics");

    expect(result.outcome).toBe("failed");
    expect(await store.load("invalid-team-metrics")).toMatchObject({
      status: "failed",
      budget: { consumed: {} },
      stages: [expect.objectContaining({
        id: "research",
        status: "failed",
        error: { message: "pipeline_department_metrics_invalid" },
      })],
    });
  });

  it("claims a department before executing it when concurrent coordinators see the same pending stage", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    await store.create(runInput("concurrent-department-run", workspace, [{ id: "research", kind: "department" }]));
    await store.start("concurrent-department-run");

    const originalLoad = store.load.bind(store);
    let initialLoads = 0;
    let releaseInitialLoads!: () => void;
    const initialLoadsReady = new Promise<void>((resolve) => { releaseInitialLoads = resolve; });
    const gatedStore = Object.create(store) as PipelineRunStore;
    gatedStore.load = async (runId: string) => {
      const run = await originalLoad(runId);
      if (initialLoads < 2) {
        initialLoads += 1;
        if (initialLoads === 2) releaseInitialLoads();
        await initialLoadsReady;
      }
      return run;
    };

    let executions = 0;
    const executeDepartment = async ({ run, stage }: { run: { runId: string }; stage: { id: string } }) => {
      executions += 1;
      return departmentArtifact(run.runId, stage.id);
    };
    const first = new PipelineMissionRunner({ runStore: gatedStore, executeDepartment }).advance("concurrent-department-run");
    const second = new PipelineMissionRunner({ runStore: gatedStore, executeDepartment }).advance("concurrent-department-run");
    await initialLoadsReady;
    await Promise.all([first, second]);

    expect(executions).toBe(1);
    expect(await store.load("concurrent-department-run")).toMatchObject({
      status: "completed",
      artifacts: [expect.objectContaining({ id: "artifact-research" })],
      stages: [expect.objectContaining({ id: "research", attempts: 1, status: "completed" })],
    });
  });

  it("creates a durable approval wait and continues only after an approved receipt", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    await store.create(runInput("approval-run", workspace, [
      { id: "approve", kind: "approval" },
      { id: "research", kind: "department", dependsOn: ["approve"] },
    ]));
    await store.start("approval-run");
    const runner = new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async ({ run, stage }) => departmentArtifact(run.runId, stage.id),
    });

    expect((await runner.advance("approval-run")).outcome).toBe("awaiting_approval");
    const waiting = await store.load("approval-run");
    expect(waiting?.status).toBe("awaiting_approval");
    expect(waiting?.stages.find((stage: { id: string }) => stage.id === "approve"))
      .toMatchObject({ status: "awaiting_approval" });
    await store.recordApproval("approval-run", { stageId: "approve", status: "approved", actor: "operator" });
    await store.transition("approval-run", "running", { reason: "approval_received" });

    expect((await runner.advance("approval-run")).outcome).toBe("completed");
  });

  it("fails a read-only department without pretending that later stages can continue", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    await store.create(runInput("department-failure", workspace, [{ id: "research", kind: "department" }]));
    await store.start("department-failure");

    const result = await new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async () => { throw new Error("source repository cannot be read"); },
    }).advance("department-failure");

    expect(result.outcome).toBe("failed");
    expect(await store.load("department-failure")).toMatchObject({
      status: "failed",
    });
  });

  it("charges bounded provider usage when a Team department fails", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    await store.create(runInput("metered-department-failure", workspace, [{ id: "research", kind: "department" }]));
    await store.start("metered-department-failure");

    const result = await new PipelineMissionRunner({
      runStore: store,
      executeDepartment: async () => {
        throw Object.assign(new Error("upstream provider unavailable"), {
          budgetMetrics: {
            inputTokens: 4,
            outputTokens: 1,
            totalTokens: 5,
            providerCalls: 2,
            unmeteredProviderCalls: 1,
            durationMs: 18,
            costUsd: 0.002,
          },
        });
      },
    }).advance("metered-department-failure");

    expect(result.outcome).toBe("failed");
    expect(await store.load("metered-department-failure")).toMatchObject({
      status: "failed",
      artifacts: [],
      budget: {
        consumed: {
          inputTokens: 4,
          outputTokens: 1,
          totalTokens: 5,
          calls: 1,
          wallTimeMs: 18,
          costUsd: 0.002,
        },
        unmeteredCalls: 1,
      },
      stages: [expect.objectContaining({
        id: "research",
        status: "failed",
        error: { message: "upstream provider unavailable" },
      })],
    });
  });

  it("serializes an action behind a workspace lease and binds the truth receipt to its exact digest", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const actionReceipts = new WeakSet<object>();
    const truthReceipts = new WeakSet<object>();
    const store = new PipelineRunStore({
      dataDir,
      isVerifiedActionReceipt: (receipt) => actionReceipts.has(receipt as object),
      isVerifiedTruthGate: (receipt) => truthReceipts.has(receipt as object),
    });
    const leases = new WorkspaceLeaseStore({ dataDir });
    await store.create(runInput("action-run", workspace, [
      { id: "apply", kind: "action" },
      { id: "accept", kind: "truth-gate", dependsOn: ["apply"] },
    ]));
    await store.start("action-run");

    const actionReceipt = {
      workspaceDigestBefore: BASELINE,
      workspaceDigest: AFTER_ACTION,
      observedAt: "2026-07-13T00:01:00.000Z",
    };
    const runner = new PipelineMissionRunner({
      runStore: store,
      workspaceLeaseStore: leases,
      executeAction: async () => actionReceipt,
      authorizeActionReceipt: (receipt) => {
        actionReceipts.add(receipt as object);
        return true;
      },
      verifyTruthGate: async ({ actionReceiptDigests }) => ({
        workspaceDigest: AFTER_ACTION,
        observedAt: "2026-07-13T00:02:00.000Z",
        evidenceIds: ["test-suite"],
        actionReceiptDigests,
      }),
      authorizeTruthGateReceipt: (receipt) => {
        truthReceipts.add(receipt as object);
        return true;
      },
    });

    expect((await runner.advance("action-run")).outcome).toBe("completed");
    const completed = await store.load("action-run");
    const action = completed?.stages.find((stage: { id: string }) => stage.id === "apply");
    const truth = completed?.stages.find((stage: { id: string }) => stage.id === "accept");
    expect(truth?.truthGateReceipt.actionReceiptDigests).toEqual([action?.actionReceiptDigest]);
    expect(await leases.get(workspace)).toBeNull();
  });

  it("never starts a write without a trusted action adapter and leaves a failed write uncertain with its lease held", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace);
    const store = new PipelineRunStore({ dataDir });
    const leases = new WorkspaceLeaseStore({ dataDir });
    await store.create(runInput("no-action-adapter", workspace, [{ id: "apply", kind: "action" }]));
    await store.start("no-action-adapter");
    const blocked = await new PipelineMissionRunner({ runStore: store }).advance("no-action-adapter");
    expect(blocked.outcome).toBe("blocked");
    expect(await leases.get(workspace)).toBeNull();

    const writerReceipts = new WeakSet<object>();
    await store.create(runInput("failed-action", workspace, [{ id: "apply", kind: "action" }]));
    await store.start("failed-action");
    const failed = await new PipelineMissionRunner({
      runStore: new PipelineRunStore({
        dataDir,
        isVerifiedActionReceipt: (receipt) => writerReceipts.has(receipt as object),
      }),
      workspaceLeaseStore: leases,
      executeAction: async () => { throw new Error("executor crashed after acquiring the lease"); },
      authorizeActionReceipt: () => true,
    }).advance("failed-action");
    expect(failed.outcome).toBe("uncertain");
    expect((await store.load("failed-action"))?.stages).toEqual([
      expect.objectContaining({ id: "apply", status: "uncertain", uncertain: true }),
    ]);
    expect(await leases.get(workspace)).toMatchObject({ runId: "failed-action", stageId: "apply" });
  });
});
