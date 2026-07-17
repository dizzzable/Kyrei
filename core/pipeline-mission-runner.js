/**
 * Deterministic mission coordinator for the durable Pipeline control plane.
 *
 * It deliberately knows nothing about a specific model SDK. The gateway (or a
 * future Team runtime adapter) supplies bounded department/action/verifier
 * executors; this class owns ordering, hand-off boundaries, approval waits,
 * workspace leases, and durable state transitions.
 */

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const COMPLETED_STAGE_STATUS = "completed";

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error ?? "pipeline stage failed");
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : errorText(error);
}

function isWriteStage(stage) {
  return stage?.writeCapable === true || stage?.kind === "action";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stageDependenciesSatisfied(run, stage) {
  const byId = new Map(run.stages.map((candidate) => [candidate.id, candidate]));
  return stage.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === COMPLETED_STAGE_STATUS);
}

function ancestorStageIds(run, stage) {
  const byId = new Map(run.stages.map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  const pending = [...(stage.dependsOn ?? [])];
  while (pending.length) {
    const stageId = pending.pop();
    if (seen.has(stageId)) continue;
    seen.add(stageId);
    const candidate = byId.get(stageId);
    if (candidate?.dependsOn?.length) pending.push(...candidate.dependsOn);
  }
  return seen;
}

function dependencyArtifacts(run, stage) {
  const byStage = new Map();
  for (const artifact of run.artifacts) {
    const values = byStage.get(artifact.stageId) ?? [];
    values.push(structuredClone(artifact));
    byStage.set(artifact.stageId, values);
  }
  // Write/truth-gate stages need upstream department artifacts (e.g. patch evidence
  // on implementation) even when they only directly depend on an approval stage.
  const stageIds = (isWriteStage(stage) || stage.kind === "truth-gate")
    ? [...ancestorStageIds(run, stage)]
    : [...(stage.dependsOn ?? [])];
  const selectedStageIds = new Set(stageIds);
  for (const approval of run.approvals ?? []) {
    if (approval?.status !== "approved" || !selectedStageIds.has(approval.stageId)) continue;
    let decision = "";
    try {
      decision = JSON.stringify(approval.metadata ?? {});
    } catch {
      decision = "";
    }
    const values = byStage.get(approval.stageId) ?? [];
    values.push({
      id: `human:${approval.id}`,
      stageId: approval.stageId,
      summary: [
        approval.reason || "Human decision approved.",
        decision && decision !== "{}" ? `Human decision: ${decision.slice(0, 4_000)}` : "",
      ].filter(Boolean).join("\n"),
      provenance: { providerId: "human", modelId: "operator", policyDigest: "human-decision" },
      uncertainties: [],
      unchecked: [],
      humanDecision: structuredClone(approval.metadata ?? {}),
    });
    byStage.set(approval.stageId, values);
  }
  return Object.fromEntries(stageIds.map((stageId) => [stageId, byStage.get(stageId) ?? []]));
}

function upstreamActionReceiptDigests(run, stage) {
  const stages = new Map(run.stages.map((candidate) => [candidate.id, candidate]));
  const visited = new Set();
  const digests = new Set();
  const visit = (stageId) => {
    if (visited.has(stageId)) return;
    visited.add(stageId);
    const candidate = stages.get(stageId);
    if (!candidate) throw new Error("pipeline_stage_dependency_missing");
    for (const dependencyId of candidate.dependsOn) visit(dependencyId);
    if (isWriteStage(candidate)) {
      if (typeof candidate.actionReceiptDigest !== "string") {
        throw new Error("pipeline_truth_gate_action_lineage_invalid");
      }
      digests.add(candidate.actionReceiptDigest);
    }
  };
  for (const dependencyId of stage.dependsOn) visit(dependencyId);
  return [...digests].sort();
}

function executorResult(value, key) {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : value;
}

function safeMetric(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function requiredMetric(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("pipeline_department_metrics_invalid");
  return value;
}

function safeCost(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function requiredCost(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("pipeline_department_metrics_invalid");
  return value;
}

function departmentBudgetUsage(artifact, reportedMetrics = undefined) {
  const reported = reportedMetrics !== undefined;
  if (reported && !isObject(reportedMetrics)) throw new Error("pipeline_department_metrics_invalid");
  const metrics = reported
    ? reportedMetrics
    : isObject(artifact?.metrics)
      ? artifact.metrics
      : {};
  const metric = reported ? requiredMetric : safeMetric;
  const inputTokens = metric(metrics.inputTokens);
  const outputTokens = metric(metrics.outputTokens);
  const totalTokens = metric(metrics.totalTokens);
  if (totalTokens !== inputTokens + outputTokens) {
    throw new Error("pipeline_department_metrics_invalid");
  }
  const providerCalls = metric(metrics.providerCalls);
  const unmeteredCalls = reported ? requiredMetric(metrics.unmeteredProviderCalls) : safeMetric(metrics.unmeteredProviderCalls);
  if (unmeteredCalls > providerCalls) {
    throw new Error("pipeline_department_metrics_invalid");
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    calls: providerCalls - unmeteredCalls,
    unmeteredCalls,
    wallTimeMs: metric(metrics.durationMs),
    costUsd: reported && metrics.costUsd !== undefined ? requiredCost(metrics.costUsd) : safeCost(metrics.costUsd),
  };
}

function stoppedOutcome(status) {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "uncertain";
  if (status === "blocked") return "blocked";
  if (status === "budget_paused") return "budget_paused";
  return "waiting";
}

function authorizedReceipt(result, original) {
  return result === undefined || result === true ? original : result;
}

export class PipelineMissionRunner {
  constructor({
    runStore,
    workspaceLeaseStore,
    executeDepartment,
    executeAction,
    verifyTruthGate,
    authorizeActionReceipt,
    authorizeTruthGateReceipt,
    onEvent = () => {},
    maxStageTransitions = 100,
  } = {}) {
    if (
      !runStore
      || typeof runStore.load !== "function"
      || typeof runStore.updateStage !== "function"
      || typeof runStore.completeDepartmentWithArtifact !== "function"
      || typeof runStore.failDepartmentWithUsage !== "function"
      || typeof runStore.claimStage !== "function"
    ) {
      throw new TypeError("pipeline_runner_run_store_required");
    }
    if (workspaceLeaseStore != null && typeof workspaceLeaseStore.acquire !== "function") {
      throw new TypeError("pipeline_runner_workspace_lease_store_invalid");
    }
    for (const [name, value] of Object.entries({
      executeDepartment,
      executeAction,
      verifyTruthGate,
      authorizeActionReceipt,
      authorizeTruthGateReceipt,
      onEvent,
    })) {
      if (value !== undefined && typeof value !== "function") {
        throw new TypeError(`pipeline_runner_${name}_invalid`);
      }
    }
    if (!Number.isSafeInteger(maxStageTransitions) || maxStageTransitions < 1 || maxStageTransitions > 10_000) {
      throw new RangeError("pipeline_runner_max_stage_transitions_invalid");
    }
    this.runStore = runStore;
    this.workspaceLeaseStore = workspaceLeaseStore;
    this.executeDepartment = executeDepartment;
    this.executeAction = executeAction;
    this.verifyTruthGate = verifyTruthGate;
    this.authorizeActionReceipt = authorizeActionReceipt;
    this.authorizeTruthGateReceipt = authorizeTruthGateReceipt;
    this.onEvent = onEvent;
    this.maxStageTransitions = maxStageTransitions;
  }

  _emit(type, payload) {
    try {
      this.onEvent({ type, payload });
    } catch {
      // Audit/telemetry cannot be allowed to alter durable mission semantics.
    }
  }

  async _block(run, stage, reason) {
    const next = await this.runStore.updateStage(run.runId, stage.id, {
      status: "blocked",
      error: { code: reason },
    });
    const blocked = await this.runStore.transition(run.runId, "blocked", { stageId: stage.id, reason });
    this._emit("pipeline.stage.blocked", { runId: run.runId, stageId: stage.id, reason });
    return blocked ?? next;
  }

  async _fail(run, stage, error, expectedExecutionClaimId = undefined) {
    const message = errorText(error).slice(0, 4_000);
    let current = await this.runStore.load(run.runId);
    const latest = current?.stages.find((candidate) => candidate.id === stage.id);
    if (expectedExecutionClaimId !== undefined && latest?.executionClaimId !== expectedExecutionClaimId) return current ?? run;
    if (latest?.status === "running") {
      current = await this.runStore.updateStage(run.runId, stage.id, {
        status: "failed",
        error: { message },
        ...(expectedExecutionClaimId !== undefined ? { expectedExecutionClaimId } : {}),
      });
    }
    const failedStage = current?.stages.find((candidate) => candidate.id === stage.id);
    if (failedStage?.status === "uncertain" || failedStage?.uncertain) {
      const interrupted = await this.runStore.transition(run.runId, "interrupted", {
        stageId: stage.id,
        reason: "write_outcome_uncertain",
      });
      this._emit("pipeline.stage.uncertain", { runId: run.runId, stageId: stage.id, error: message });
      return interrupted;
    }
    const failed = await this.runStore.transition(run.runId, "failed", {
      stageId: stage.id,
      reason: message,
    });
    this._emit("pipeline.stage.failed", { runId: run.runId, stageId: stage.id, error: message });
    return failed;
  }

  async _runDepartment(run, stage, signal, expectedExecutionClaimId) {
    if (!this.executeDepartment) return this._block(run, stage, "department_executor_unavailable");
    this._emit("pipeline.department.started", { runId: run.runId, stageId: stage.id });
    try {
      const outcome = await this.executeDepartment({
        run: structuredClone(run),
        stage: structuredClone(stage),
        dependencyArtifacts: dependencyArtifacts(run, stage),
        signal,
      });
      const artifact = executorResult(outcome, "artifact");
      const reportedMetrics = isObject(outcome) && Object.hasOwn(outcome, "budgetMetrics")
        ? outcome.budgetMetrics
        : undefined;
      // A pause/cancel can race a cooperative provider transport. Never save
      // that late answer as a hand-off after the mission has stopped.
      const current = await this.runStore.load(run.runId);
      const currentStage = current?.stages.find((candidate) => candidate.id === stage.id);
      if (signal?.aborted || current?.status !== "running" || currentStage?.status !== "running") {
        return current ?? run;
      }
      const next = await this.runStore.completeDepartmentWithArtifact(
        run.runId,
        stage.id,
        artifact,
        departmentBudgetUsage(artifact, reportedMetrics),
        expectedExecutionClaimId,
      );
      this._emit("pipeline.department.completed", { runId: run.runId, stageId: stage.id, artifactId: artifact?.id });
      return next;
    } catch (error) {
      if (signal?.aborted) {
        const current = await this.runStore.load(run.runId);
        if (current && current.status !== "running") return current;
      }
      if (errorCode(error) === "department_executor_unavailable") {
        return this._block(run, stage, "department_executor_unavailable");
      }
      if (isObject(error) && Object.hasOwn(error, "budgetMetrics")) {
        try {
          const budgetUsage = departmentBudgetUsage(undefined, error.budgetMetrics);
          await this.runStore.failDepartmentWithUsage(
            run.runId,
            stage.id,
            { message: errorText(error).slice(0, 4_000) },
            budgetUsage,
            expectedExecutionClaimId,
          );
        } catch (budgetError) {
          return this._fail(run, stage, budgetError, expectedExecutionClaimId);
        }
      }
      return this._fail(run, stage, error, expectedExecutionClaimId);
    }
  }

  async _runAction(run, stage, signal, expectedExecutionClaimId) {
    if (!this.executeAction || !this.workspaceLeaseStore || !this.authorizeActionReceipt) {
      return this._block(run, stage, "action_executor_unavailable");
    }
    let lease = null;
    try {
      lease = await this.workspaceLeaseStore.acquire({
        workspace: run.workspace,
        runId: run.runId,
        stageId: stage.id,
      });
      this._emit("pipeline.action.started", { runId: run.runId, stageId: stage.id, leaseId: lease.id });
      const outcome = await this.executeAction({
        run: structuredClone(run),
        stage: structuredClone(stage),
        dependencyArtifacts: dependencyArtifacts(run, stage),
        signal,
        lease: structuredClone(lease),
      });
      const actionReceipt = executorResult(outcome, "actionReceipt");
      const verifiedReceipt = authorizedReceipt(
        await this.authorizeActionReceipt(actionReceipt, { run, stage }),
        actionReceipt,
      );
      const next = await this.runStore.updateStage(run.runId, stage.id, {
        status: "completed",
        actionReceipt: verifiedReceipt,
        expectedExecutionClaimId,
      });
      await this.workspaceLeaseStore.release({ workspace: run.workspace, leaseId: lease.id, runId: run.runId });
      this._emit("pipeline.action.completed", { runId: run.runId, stageId: stage.id });
      return next;
    } catch (error) {
      // A failed write deliberately retains its lease: recovery must quarantine
      // it and require a deterministic resolution before another attempt.
      return this._fail(run, stage, error, expectedExecutionClaimId);
    }
  }

  async _runTruthGate(run, stage, signal, expectedExecutionClaimId) {
    if (!this.verifyTruthGate || !this.authorizeTruthGateReceipt) {
      return this._block(run, stage, "truth_gate_verifier_unavailable");
    }
    try {
      const actionReceiptDigests = upstreamActionReceiptDigests(run, stage);
      const outcome = await this.verifyTruthGate({
        run: structuredClone(run),
        stage: structuredClone(stage),
        dependencyArtifacts: dependencyArtifacts(run, stage),
        actionReceiptDigests,
        signal,
      });
      const truthGateReceipt = executorResult(outcome, "truthGateReceipt");
      const verifiedReceipt = authorizedReceipt(
        await this.authorizeTruthGateReceipt(truthGateReceipt, { run, stage }),
        truthGateReceipt,
      );
      const next = await this.runStore.updateStage(run.runId, stage.id, {
        status: "completed",
        truthGateReceipt: verifiedReceipt,
        expectedExecutionClaimId,
      });
      this._emit("pipeline.truth_gate.completed", { runId: run.runId, stageId: stage.id });
      return next;
    } catch (error) {
      return this._fail(run, stage, error, expectedExecutionClaimId);
    }
  }

  async _requestApproval(run, stage) {
    try {
      const dependencies = dependencyArtifacts(run, stage);
      const clarificationRequests = Object.values(dependencies)
        .flatMap((artifacts) => (Array.isArray(artifacts) ? artifacts : []))
        .flatMap((artifact) => (Array.isArray(artifact?.clarifications) ? artifact.clarifications : []))
        .slice(0, 8);
      const isClarification = clarificationRequests.length > 0;
      await this.runStore.recordApproval(run.runId, {
        stageId: stage.id,
        status: "requested",
        kind: isClarification ? "clarification" : "stage",
        actor: "pipeline-runner",
        reason: isClarification
          ? "human clarification required before the next mission stage"
          : "human approval required before the next mission stage",
        ...(isClarification
          ? {
              metadata: {
                clarificationRequests: structuredClone(clarificationRequests),
              },
            }
          : {}),
      });
    } catch (error) {
      if (errorCode(error) === "pipeline_approval_transition_invalid") return (await this.runStore.load(run.runId)) ?? run;
      throw error;
    }
    const waiting = await this.runStore.transition(run.runId, "awaiting_approval", { stageId: stage.id });
    this._emit("pipeline.approval.requested", { runId: run.runId, stageId: stage.id });
    return waiting;
  }

  /** Advance one mission until it waits, blocks, terminates, or exhausts its bounded transition budget. */
  async advance(runId, { signal } = {}) {
    let transitions = 0;
    for (;;) {
      if (signal?.aborted) {
        const run = await this.runStore.load(runId);
        return { run, outcome: "aborted", transitions };
      }
      const run = await this.runStore.load(runId);
      if (!run) throw new Error("pipeline_run_not_found");
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { run, outcome: "terminal", transitions };
      if (run.status !== "running") return { run, outcome: "waiting", transitions };
      if (run.budget?.exhausted === true && !run.stages.every((stage) => stage.status === COMPLETED_STAGE_STATUS)) {
        const paused = await this.runStore.transition(run.runId, "budget_paused", {
          reason: "pipeline_budget_exhausted",
        });
        this._emit("pipeline.budget.paused", { runId: run.runId });
        return { run: paused, outcome: "budget_paused", transitions };
      }

      if (transitions >= this.maxStageTransitions) {
        const pending = run.stages.find((stage) => stage.status === "pending");
        if (!pending) return { run, outcome: "waiting", transitions };
        const blocked = await this._block(run, pending, "runner_transition_budget_exhausted");
        return { run: blocked, outcome: "blocked", transitions };
      }

      const ready = run.stages.find((stage) => (
        (stage.status === "pending" || (stage.kind === "department" && stage.status === "interrupted"))
        && stageDependenciesSatisfied(run, stage)
      ));
      if (!ready) {
        if (run.stages.every((stage) => stage.status === COMPLETED_STAGE_STATUS)) {
          const completed = await this.runStore.transition(run.runId, "completed", { reason: "all_stages_completed" });
          this._emit("pipeline.completed", { runId: run.runId });
          return { run: completed, outcome: "completed", transitions };
        }
        const failed = run.stages.find((stage) => stage.status === "failed");
        if (failed) {
          const terminal = await this.runStore.transition(run.runId, "failed", { stageId: failed.id });
          return { run: terminal, outcome: "failed", transitions };
        }
        return { run, outcome: "waiting", transitions };
      }

      if (ready.kind === "approval") {
        transitions += 1;
        const next = await this._requestApproval(run, ready);
        return { run: next, outcome: "awaiting_approval", transitions };
      }
      const unavailableReason = ready.kind === "department" && !this.executeDepartment
        ? "department_executor_unavailable"
        : isWriteStage(ready) && (!this.executeAction || !this.workspaceLeaseStore || !this.authorizeActionReceipt)
          ? "action_executor_unavailable"
          : ready.kind === "truth-gate" && (!this.verifyTruthGate || !this.authorizeTruthGateReceipt)
            ? "truth_gate_verifier_unavailable"
            : null;
      if (unavailableReason) {
        transitions += 1;
        const next = await this._block(run, ready, unavailableReason);
        return { run: next, outcome: "blocked", transitions };
      }
      let claim;
      try {
        claim = await this.runStore.claimStage(run.runId, ready.id, {
          expectedStatus: ready.status,
          ...(isWriteStage(ready) ? { workspaceDigestBefore: run.workspaceCheckpointDigest } : {}),
        });
      } catch (error) {
        if (["pipeline_stage_run_inactive", "pipeline_stage_transition_invalid"].includes(errorCode(error))) continue;
        throw error;
      }
      if (!claim.claimed) continue;
      const claimedStage = claim.run.stages.find((stage) => stage.id === ready.id);
      if (!claimedStage) throw new Error("pipeline_stage_not_found");
      transitions += 1;
      if (ready.kind === "department") {
        const next = await this._runDepartment(claim.run, claimedStage, signal, claim.executionClaimId);
        if (next.status !== "running") return { run: next, outcome: stoppedOutcome(next.status), transitions };
        continue;
      }
      if (isWriteStage(ready)) {
        const next = await this._runAction(claim.run, claimedStage, signal, claim.executionClaimId);
        if (next.status !== "running") return { run: next, outcome: stoppedOutcome(next.status), transitions };
        continue;
      }
      if (ready.kind === "truth-gate") {
        const next = await this._runTruthGate(claim.run, claimedStage, signal, claim.executionClaimId);
        if (next.status !== "running") return { run: next, outcome: stoppedOutcome(next.status), transitions };
        continue;
      }
      const next = await this._block(claim.run, claimedStage, "stage_kind_unsupported");
      return { run: next, outcome: "blocked", transitions };
    }
  }
}
