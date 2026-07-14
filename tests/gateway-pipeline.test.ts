import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { createDefaultCodingPipeline } from "../core/pipeline-config.js";
import { PipelineRunStore } from "../core/pipeline-run-store.js";
import { WorkspaceLeaseStore } from "../core/workspace-lease-store.js";
import { rebaseImportedPipelines } from "../src/lib/pipeline-import";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-pipeline-"));
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => ({ runKyreiChat: async () => ({ text: "done", parts: [] }), listModels: () => [] }),
  });
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function response(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await response(path, init);
  const body = await result.json() as T & { error?: string; code?: string };
  if (!result.ok) throw new Error(body.code ?? body.error ?? String(result.status));
  return body;
}

async function waitForPipelineRun<T extends { status: string }>(
  runId: string,
  predicate: (run: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const response = await request<{ run: T }>(`/api/pipeline-runs/${runId}`);
    last = response.run;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pipeline did not reach the expected state: ${JSON.stringify(last)}`);
}

const teamLimits = {
  maxParallel: 2,
  maxDepth: 1,
  maxAgents: 8,
  maxTasks: 8,
  maxStepsPerAgent: 6,
  timeoutMs: 120_000,
};

function profile(id: string) {
  return {
    id,
    name: id,
    workflow: "supervisor",
    enabled: true,
    roles: [{
      id: `${id}-member`,
      name: `${id} member`,
      description: "",
      instructions: "Return evidence.",
      skillIds: [],
      capabilities: ["workspace.read"],
      canSpawn: false,
      maxChildren: 0,
    }],
    limits: teamLimits,
  };
}

function organizationConfig() {
  const profiles = ["research-team", "planning-team", "executor-team", "test-team"].map(profile);
  const definition = createDefaultCodingPipeline({
    research: "research-team",
    planning: "planning-team",
    execution: "executor-team",
    verification: "test-team",
  });
  return {
    orchestration: { defaultMode: "single", activeProfileId: "", profiles },
    pipelines: { version: 1, definitions: [definition] },
  };
}

function departmentArtifact(runId: string, stageId: string, workspaceDigest: string) {
  return {
    schemaVersion: 1,
    id: `artifact-${stageId}`,
    kind: "department",
    runId,
    stageId,
    producerId: `${stageId}-team`,
    createdAt: "2026-07-13T00:00:00.000Z",
    summary: `${stageId} evidence summary`,
    workspaceDigest,
    inputDigests: [],
    assumptions: [],
    uncertainties: [],
    unchecked: [],
    provenance: {
      providerId: "test-local",
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

function teamDepartmentResult(
  stageId: string,
  marker = "",
  metrics: { inputTokens?: number; outputTokens?: number } = {},
) {
  const artifact = {
    taskId: `task-${stageId}`,
    summary: `Structured ${stageId} result ${marker}`.trim(),
    provenance: [`model structured response ${marker}`.trim()],
    confidence: 0.8,
    evidence: [`reported ${stageId} evidence ${marker}`.trim()],
    validation: [`reviewed ${stageId}`],
    uncertainties: ["No deterministic verifier has run."],
    whatWasNotChecked: ["No workspace mutation was attempted."],
  };
  return {
    runId: `team-${stageId}`,
    artifact,
    taskResults: [{
      status: "succeeded",
      artifact: {
        ...artifact,
        metrics: {
          inputTokens: metrics.inputTokens ?? 7,
          outputTokens: metrics.outputTokens ?? 3,
        },
      },
    }],
  };
}

async function configureOrganization() {
  const workspace = join(dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  return request<{
    workspace: string;
    pipelines: { definitions: Array<{ id: string; revision: number }> };
  }>("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      workspace,
      providers: [{
        id: "test-local",
        name: "Test local",
        protocol: "openai-chat",
        baseURL: "http://127.0.0.1:11434/v1",
        requiresApiKey: false,
        enabled: true,
        models: [{ id: "test-model", name: "Test model" }],
      }],
      activeProviderId: "test-local",
      activeModelId: "test-model",
      ...organizationConfig(),
    }),
  });
}

describe("gateway Pipeline v1 control plane", () => {
  it("validates and atomically persists organization definitions composed from Team profiles", async () => {
    expect(await request("/api/pipelines")).toEqual({ version: 1, generation: 0, definitions: [] });
    const configured = await configureOrganization();
    expect(configured.pipelines.definitions[0]).toMatchObject({ id: "coding-product", revision: 1 });

    const invalid = await request<ReturnType<typeof organizationConfig>["pipelines"] & { generation: number }>("/api/pipelines");
    invalid.definitions[0].stages[0] = {
      ...invalid.definitions[0].stages[0],
      teamProfileId: "missing-team",
    };
    const rejected = await response("/api/pipelines", { method: "PUT", body: JSON.stringify(invalid) });
    expect(rejected.status).toBe(400);
    expect(await request<{ definitions: Array<{ id: string }> }>("/api/pipelines"))
      .toMatchObject({ definitions: [{ id: "coding-product" }] });

    const unsafeSandboxFallback = await response("/api/config", {
      method: "PUT",
      body: JSON.stringify({ engine: { sandbox: "strict-requred" } }),
    });
    expect(unsafeSandboxFallback.status).toBe(400);
    expect(await unsafeSandboxFallback.json()).toMatchObject({ code: "engine_sandbox_invalid" });
  });

  it("accepts fresh, identical, and changed backups after local CAS rebasing", async () => {
    const workspace = join(dataDir, "restored-workspace");
    await mkdir(workspace, { recursive: true });
    const backup = organizationConfig();
    const empty = await request<any>("/api/pipelines");
    const fresh = rebaseImportedPipelines(backup.pipelines, empty)!;
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspace, orchestration: backup.orchestration, pipelines: fresh }),
    });

    const current = await request<any>("/api/pipelines");
    const identical = rebaseImportedPipelines({
      generation: 999,
      definitions: current.definitions.map((definition: any) => ({ ...definition, revision: 999 })),
    }, current)!;
    expect(identical.definitions[0].revision).toBe(current.definitions[0].revision);
    await request("/api/pipelines", { method: "PUT", body: JSON.stringify(identical) });

    const afterIdentical = await request<any>("/api/pipelines");
    const changed = rebaseImportedPipelines({
      definitions: [{ ...afterIdentical.definitions[0], name: "Restored changed name", revision: 1 }],
    }, afterIdentical)!;
    expect(changed.definitions[0].revision).toBe(afterIdentical.definitions[0].revision + 1);
    await request("/api/pipelines", { method: "PUT", body: JSON.stringify(changed) });
  });

  it("creates a revision-pinned cross-session mission and audits lifecycle operations", async () => {
    await configureOrganization();
    const firstSession = await request<{ id: string }>("/api/sessions", { method: "POST" });
    const secondSession = await request<{ id: string }>("/api/sessions", { method: "POST" });

    const created = await request<{ run: {
      runId: string;
      status: string;
      definitionRevision: string;
      definitionDigest: string;
      runtimeFingerprint: string;
      workspaceBaselineDigest: string;
      stages: Array<{ id: string; writeCapable: boolean }>;
      attachedSessionIds: string[];
    } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Ship a verified feature", sessionId: firstSession.id }),
    });
    expect(created.run).toMatchObject({
      status: "queued",
      definitionRevision: "1",
      attachedSessionIds: [firstSession.id],
    });
    expect(created.run.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(created.run.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(created.run.workspaceBaselineDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(created.run.stages.find((stage) => stage.id === "apply-changes"))
      .toMatchObject({ writeCapable: true });

    const scheduler = new PipelineRunStore({ dataDir });
    await scheduler.start(created.run.runId);
    await scheduler.updateStage(created.run.runId, "research", { status: "running" });
    await request(`/api/pipeline-runs/${created.run.runId}/artifact`, {
      method: "POST",
      body: JSON.stringify({ artifact: departmentArtifact(created.run.runId, "research", created.run.workspaceBaselineDigest) }),
    });
    await scheduler.updateStage(created.run.runId, "research", { status: "completed" });
    await scheduler.updateStage(created.run.runId, "planning", { status: "running" });
    await scheduler.recordArtifact(created.run.runId, departmentArtifact(
      created.run.runId,
      "planning",
      created.run.workspaceBaselineDigest,
    ));
    await scheduler.updateStage(created.run.runId, "planning", { status: "completed" });
    await scheduler.recordApproval(created.run.runId, {
      stageId: "approve-plan",
      status: "approved",
      actor: "human",
      reason: "Reviewed",
    });
    await request(`/api/pipeline-runs/${created.run.runId}/attach-session`, {
      method: "POST",
      body: JSON.stringify({ sessionId: secondSession.id }),
    });
    await request(`/api/pipeline-runs/${created.run.runId}/attach-session`, {
      method: "POST",
      body: JSON.stringify({ sessionId: secondSession.id }),
    });
    await request(`/api/pipeline-runs/${created.run.runId}/pause`, {
      method: "POST",
      body: JSON.stringify({ reason: "operator review" }),
    });
    const resumed = await request<{ run: { status: string; attachedSessionIds: string[]; approvals: unknown[] } }>(
      `/api/pipeline-runs/${created.run.runId}/resume`,
      { method: "POST", body: "{}" },
    );
    expect(resumed.run.status).toBe("running");
    expect(resumed.run.attachedSessionIds).toEqual([firstSession.id, secondSession.id]);
    expect(resumed.run.approvals).toHaveLength(1);

    const listed = await request<{ runs: Array<{ runId: string }> }>("/api/pipeline-runs");
    expect(listed.runs.map((run) => run.runId)).toContain(created.run.runId);
    const journal = await request<{ events: Array<{ type: string; sequence: number }> }>(
      `/api/pipeline-runs/${created.run.runId}/journal`,
    );
    expect(journal.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run.created",
      "run.running",
      "approval.recorded",
      "session.attached",
      "run.paused",
      "run.resumed",
    ]));
    expect(journal.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: journal.events.length }, (_, index) => index + 1),
    );
  });

  it("materializes every explicitly selected skill for a pipeline department profile", async () => {
    await server.close();
    const calls: Array<Record<string, unknown>> = [];
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async (input: Record<string, unknown>) => {
          calls.push(input);
          return teamDepartmentResult(String(input.stageId));
        },
      }),
    });
    await configureOrganization();

    const selectedSkillIds: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const created = await request<{ skill: { id: string } }>("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name: `pipeline-selected-${index + 1}`,
          description: "Selected by the research department",
          content: "Return a concise evidence-backed result.",
        }),
      });
      selectedSkillIds.push(created.skill.id);
    }
    const current = await request<any>("/api/config");
    const orchestration = structuredClone(current.orchestration);
    const researchProfile = orchestration.profiles.find((profile: { id: string }) => profile.id === "research-team");
    researchProfile.roles[0].skillIds = selectedSkillIds;
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration }),
    });

    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Research with assigned skills" }),
    });
    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.stages.find((stage: { id: string }) => stage.id === "research")?.status === "completed",
    );

    const researchCall = calls.find((call) => (
      (call.team as { profileId?: string }).profileId === "research-team"
    ));
    expect(researchCall).toBeDefined();
    expect((researchCall?.skills as Array<{ id: string }>).map((skill) => skill.id).sort())
      .toEqual([...selectedSkillIds].sort());
  });

  it("runs pinned Team departments through the direct adapter and blocks before an untrusted write", async () => {
    await server.close();
    const calls: Array<Record<string, unknown>> = [];
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async (input: Record<string, unknown>) => {
          calls.push(input);
          const team = input.team as {
            roles: Array<{ target: { providerId: string; accountId?: string; model: string } }>;
          };
          const lifecycle = input.providerAttemptLifecycle as {
            acquire(target: Record<string, unknown>): unknown | null;
            release(handle: unknown, outcome: Record<string, unknown>): void;
          };
          const roleTarget = team.roles[0]!.target;
          const attemptTarget = {
            providerId: roleTarget.providerId,
            ...(roleTarget.accountId ? { accountId: roleTarget.accountId } : {}),
            modelId: roleTarget.model,
          };
          const lease = lifecycle.acquire(attemptTarget);
          if (!lease) throw new Error("pipeline provider capacity unavailable");
          lifecycle.release(lease, { ...attemptTarget, outcome: "success", phase: "stream" });
          const stageId = String(input.stageId);
          const artifact = {
            taskId: `task-${stageId}`,
            summary: `Structured ${stageId} result`,
            provenance: ["model structured response"],
            confidence: 0.8,
            evidence: [`reported ${stageId} evidence`],
            validation: [`reviewed ${stageId}`],
            uncertainties: ["No deterministic verifier has run."],
            whatWasNotChecked: ["No workspace mutation was attempted."],
          };
          return {
            runId: `team-${stageId}`,
            artifact,
            metrics: {
              inputTokens: 17,
              outputTokens: 5,
              totalTokens: 22,
              costUsd: 0.01,
              providerCalls: 4,
              unmeteredProviderCalls: 1,
            },
            taskResults: [{
              status: "succeeded",
              artifact: {
                ...artifact,
                metrics: { inputTokens: 7, outputTokens: 3 },
              },
            }],
          };
        },
      }),
    });
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Deliver a safe Team result" }),
    });

    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    const awaitingApproval = await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.status === "awaiting_approval",
    );
    expect(awaitingApproval.stages.find((stage: any) => stage.id === "research")).toMatchObject({ status: "completed" });
    expect(awaitingApproval.stages.find((stage: any) => stage.id === "planning")).toMatchObject({ status: "completed" });
    expect(awaitingApproval.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: "research", kind: "department" }),
      expect.objectContaining({ stageId: "planning", kind: "department" }),
    ]));
    const planningArtifact = awaitingApproval.artifacts.find((artifact: any) => artifact.stageId === "planning");
    expect(planningArtifact.inputDigests).toHaveLength(1);
    expect(planningArtifact.evidence[0]).toMatchObject({ kind: "diagnostic", origin: "reported" });
    expect(planningArtifact.metrics).toMatchObject({
      inputTokens: 17,
      outputTokens: 5,
      totalTokens: 22,
      providerCalls: 4,
    });
    expect(awaitingApproval.budget).toMatchObject({
      consumed: {
        inputTokens: 34,
        outputTokens: 10,
        totalTokens: 44,
        calls: 6,
        costUsd: 0.02,
      },
      unmeteredCalls: 2,
    });
    expect(calls.map((call) => (call.team as { profileId: string }).profileId)).toEqual([
      "research-team",
      "planning-team",
    ]);
    expect(calls.every((call) => Boolean(call.providerAttemptLifecycle))).toBe(true);

    await request(`/api/pipeline-runs/${created.run.runId}/approval`, {
      method: "POST",
      body: JSON.stringify({ stageId: "approve-plan", status: "approved", reason: "Reviewed" }),
    });
    const blocked = await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.status === "blocked",
    );
    expect(blocked.stages.find((stage: any) => stage.id === "implementation")).toMatchObject({ status: "completed" });
    expect(blocked.stages.find((stage: any) => stage.id === "apply-changes")).toMatchObject({
      status: "blocked",
      error: { code: "action_executor_unavailable" },
    });
    expect(calls.map((call) => String(call.stageId))).toEqual(["research", "planning", "implementation"]);
    for (const call of calls) {
      expect(call.readSkillDocument).toEqual(expect.any(Function));
    }
  });

  it("fails closed when a direct Team adapter returns a malformed artifact", async () => {
    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async () => ({
          runId: "malformed-team-result",
          artifact: {},
          taskResults: [],
        }),
      }),
    });
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Reject malformed Team output" }),
    });

    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    const failed = await waitForPipelineRun<any>(created.run.runId, (run) => run.status === "failed");
    expect(failed.stages.find((stage: any) => stage.id === "research")).toMatchObject({
      status: "failed",
      artifactIds: [],
      error: { message: "pipeline_department_artifact_invalid" },
    });
    expect(failed.artifacts).toEqual([]);
  });

  it("charges safe aggregate metrics when a direct Team department fails", async () => {
    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async () => {
          throw Object.assign(new Error("provider capacity exhausted"), {
            metrics: {
              inputTokens: 9,
              outputTokens: 2,
              totalTokens: 11,
              costUsd: 0.004,
              providerCalls: 3,
              unmeteredProviderCalls: 1,
            },
          });
        },
      }),
    });
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Meter failed Team work" }),
    });

    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    const failed = await waitForPipelineRun<any>(created.run.runId, (run) => run.status === "failed");
    expect(failed).toMatchObject({
      status: "failed",
      artifacts: [],
      budget: {
        consumed: {
          inputTokens: 9,
          outputTokens: 2,
          totalTokens: 11,
          calls: 2,
          costUsd: 0.004,
        },
        unmeteredCalls: 1,
      },
    });
    expect(failed.stages.find((stage: any) => stage.id === "research")).toMatchObject({
      status: "failed",
      error: { message: "provider capacity exhausted" },
    });
  });

  it("blocks a mission visibly when the loaded engine lacks the Team department adapter", async () => {
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Do not run against an old engine" }),
    });

    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    const blocked = await waitForPipelineRun<any>(created.run.runId, (run) => run.status === "blocked");
    expect(blocked.stages.find((stage: any) => stage.id === "research")).toMatchObject({
      status: "blocked",
      error: { code: "department_executor_unavailable" },
    });
  });

  it("does not persist a department result when the workspace changes during its provider call", async () => {
    await server.close();
    let startDepartment!: () => void;
    let releaseDepartment!: () => void;
    const started = new Promise<void>((resolve) => { startDepartment = resolve; });
    const result = new Promise<void>((resolve) => { releaseDepartment = resolve; });
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async (input: Record<string, unknown>) => {
          startDepartment();
          await result;
          return teamDepartmentResult(String(input.stageId));
        },
      }),
    });
    const configured = await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Reject stale workspace output" }),
    });

    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    await started;
    await writeFile(join(configured.workspace, "changed-during-provider-call.txt"), "changed");
    releaseDepartment();

    const failed = await waitForPipelineRun<any>(created.run.runId, (run) => run.status === "failed");
    expect(failed.stages.find((stage: any) => stage.id === "research")).toMatchObject({
      status: "failed",
      artifactIds: [],
      error: { message: "pipeline_workspace_changed" },
    });
    expect(failed.artifacts).toEqual([]);
  });

  it("aborts and redacts an in-flight Team result after credential rotation", async () => {
    await server.close();
    const oldKey = "old-credential-rotation-sentinel-12345";
    const newKey = "new-credential-rotation-sentinel-67890";
    let startResearch!: () => void;
    let releaseResearch!: () => void;
    const researchStarted = new Promise<void>((resolve) => { startResearch = resolve; });
    const researchGate = new Promise<void>((resolve) => { releaseResearch = resolve; });
    let firstInput: Record<string, unknown> | undefined;
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async (input: Record<string, unknown>) => {
          const stageId = String(input.stageId);
          const runId = `frozen-team-${stageId}`;
          const marker = stageId === "research" ? `echo ${oldKey}` : "after key rotation";
          const emit = input.emit as (event: unknown) => void;
          emit({ type: "team.start", payload: { run_id: runId, profile_id: "test" } });
          emit({
            type: "subagent.progress",
            payload: { run_id: runId, subagent_id: `${runId}:worker`, text: `provider echoed ${marker}` },
          });
          if (stageId === "research") {
            firstInput = input;
            startResearch();
            await researchGate;
          }
          return { ...teamDepartmentResult(stageId, marker), runId: stageId === "research" ? `adapter-${oldKey}` : runId };
        },
      }),
    });
    await configureOrganization();
    const added = await request<{ activeProviderId: string }>("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: {
          id: "rotating-provider",
          name: "Rotating provider",
          protocol: "openai-chat",
          baseURL: "https://rotation.example/v1",
          requiresApiKey: true,
          enabled: true,
          models: [{ id: "rotation-model", name: "Rotation model" }],
        },
        apiKey: oldKey,
        useAsDefault: true,
      }),
    });
    expect(added.activeProviderId).toBe("rotating-provider");
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Redact rotated credentials" }),
    });

    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    await researchStarted;
    expect(firstInput?.sensitiveValues).toEqual(expect.arrayContaining([oldKey]));
    await request("/api/providers/rotating-provider/secret", {
      method: "PUT",
      body: JSON.stringify({ apiKey: newKey }),
    });
    releaseResearch();

    const failed = await waitForPipelineRun<any>(created.run.runId, (run) => run.status === "failed");
    const researchEvents = await request<{ events: unknown[] }>("/api/team-runs/frozen-team-research");
    const publicData = JSON.stringify({ failed, researchEvents });
    expect(publicData).not.toContain(oldKey);
    expect(publicData).toContain("[REDACTED]");
    expect(failed.artifacts).toEqual([]);
    expect(failed.stages.find((stage: any) => stage.id === "research")).toMatchObject({
      status: "failed",
      error: { message: "provider_runtime_changed" },
    });
  });

  it("paginates long mission journals without making history unreachable", async () => {
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Create a long audit history" }),
    });
    const writer = new PipelineRunStore({ dataDir });
    for (let index = 0; index < 125; index += 1) {
      await writer.attachSession(created.run.runId, `audit-session-${index}`);
    }

    const first = await request<any>(`/api/pipeline-runs/${created.run.runId}/journal?limit=50`);
    expect(first.events).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await request<any>(
      `/api/pipeline-runs/${created.run.runId}/journal?afterSequence=${first.nextAfterSequence}&limit=50`,
    );
    expect(second.events).toHaveLength(50);
    expect(second.events[0].sequence).toBe(first.nextAfterSequence + 1);
    expect(second.hasMore).toBe(true);
  });

  it("recovers a crashed writer as uncertain and refuses resume without postcondition evidence", async () => {
    await configureOrganization();
    const created = await request<{ run: { runId: string; workspaceBaselineDigest: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Crash-safe write" }),
    });
    const direct = new PipelineRunStore({ dataDir });
    await direct.start(created.run.runId);
    await direct.updateStage(created.run.runId, "research", { status: "running" });
    await direct.recordArtifact(created.run.runId, departmentArtifact(
      created.run.runId,
      "research",
      created.run.workspaceBaselineDigest,
    ));
    await direct.updateStage(created.run.runId, "research", { status: "completed" });
    await direct.updateStage(created.run.runId, "planning", { status: "running" });
    await direct.recordArtifact(created.run.runId, departmentArtifact(
      created.run.runId,
      "planning",
      created.run.workspaceBaselineDigest,
    ));
    await direct.updateStage(created.run.runId, "planning", { status: "completed" });
    await direct.recordApproval(created.run.runId, {
      stageId: "approve-plan",
      status: "approved",
      actor: "test-operator",
    });
    await direct.updateStage(created.run.runId, "implementation", { status: "running" });
    await direct.recordArtifact(created.run.runId, departmentArtifact(
      created.run.runId,
      "implementation",
      created.run.workspaceBaselineDigest,
    ));
    await direct.updateStage(created.run.runId, "implementation", { status: "completed" });
    await direct.updateStage(created.run.runId, "apply-changes", {
      status: "running",
      workspaceDigestBefore: created.run.workspaceBaselineDigest,
    });
    const oldLeaseStore = new WorkspaceLeaseStore({ dataDir, instanceId: "crashed-writer" });
    await oldLeaseStore.acquire({
      workspace: join(dataDir, "workspace"),
      runId: created.run.runId,
      stageId: "apply-changes",
    });
    await direct.flush();

    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({ runKyreiChat: async () => ({ text: "done", parts: [] }), listModels: () => [] }),
    });

    const recovered = await request<{ run: { status: string; stages: Array<{ id: string; status: string; uncertain: boolean }> } }>(
      `/api/pipeline-runs/${created.run.runId}`,
    );
    expect(recovered.run).toMatchObject({ status: "interrupted" });
    expect(recovered.run.stages.find((stage) => stage.id === "apply-changes"))
      .toMatchObject({ status: "uncertain", uncertain: true });

    const unsafe = await response(`/api/pipeline-runs/${created.run.runId}/resume`, { method: "POST", body: "{}" });
    expect(unsafe.status).toBe(409);
    const fabricated = await response(`/api/pipeline-runs/${created.run.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({
        resolutionMarker: {
          outcome: "retry",
          workspaceDigest: "a".repeat(64),
          observedAt: new Date().toISOString(),
          evidence: [{ type: "workspace", digest: "b".repeat(64) }],
        },
      }),
    });
    expect(fabricated.status).toBe(409);
    const resolutionMarker = {
      outcome: "retry",
      workspaceDigest: created.run.workspaceBaselineDigest,
      observedAt: new Date().toISOString(),
      evidence: [{ type: "workspace", digest: created.run.workspaceBaselineDigest }],
      note: "Observed clean workspace state",
    };
    const originalResolve = WorkspaceLeaseStore.prototype.resolveQuarantine;
    let injectFailure = true;
    WorkspaceLeaseStore.prototype.resolveQuarantine = async function (...args: Parameters<typeof originalResolve>) {
      if (injectFailure) {
        injectFailure = false;
        throw new Error("injected_lease_finalize_failure");
      }
      return originalResolve.apply(this, args);
    };
    let safe!: { run: { status: string; stages: Array<{ id: string; uncertain: boolean }> } };
    try {
      const firstFinalize = await response(`/api/pipeline-runs/${created.run.runId}/resume`, {
        method: "POST",
        body: JSON.stringify({ resolutionMarker }),
      });
      expect(firstFinalize.status).toBe(500);
      safe = await request<{ run: { status: string; stages: Array<{ id: string; uncertain: boolean }> } }>(
        `/api/pipeline-runs/${created.run.runId}/resume`,
        { method: "POST", body: JSON.stringify({ resolutionMarker }) },
      );
    } finally {
      WorkspaceLeaseStore.prototype.resolveQuarantine = originalResolve;
    }
    expect(safe.run.status).toBe("running");
    expect(safe.run.stages.find((stage) => stage.id === "apply-changes")?.uncertain).toBe(false);
    expect(await new WorkspaceLeaseStore({ dataDir }).get(join(dataDir, "workspace"))).toBeNull();
  });

  it("refuses to start a queued mission after its pinned Pipeline revision changes", async () => {
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Pin the runtime" }),
    });
    const pipelines = await request<{ version: number; definitions: Array<{ revision: number }> }>("/api/pipelines");
    pipelines.definitions[0].revision += 1;
    (pipelines.definitions[0] as { name?: string }).name = "Changed coding pipeline";
    await request("/api/pipelines", { method: "PUT", body: JSON.stringify(pipelines) });

    const start = await response(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    expect(start.status).toBe(409);
    expect(await start.json()).toMatchObject({ code: "pipeline_runtime_changed" });
  });

  it("pins the effective default model used by roles without an explicit assignment", async () => {
    await configureOrganization();
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Pin inherited role models" }),
    });
    const config = await request<any>("/api/config");
    const providers = config.providers.map((provider: any) => provider.id !== "test-local"
      ? provider
      : { ...provider, models: [...provider.models, { id: "test-model-2", name: "Test model 2" }] });
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ providers, activeProviderId: "test-local", activeModelId: "test-model-2" }),
    });
    const start = await response(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    expect(start.status).toBe(409);
    expect(await start.json()).toMatchObject({ code: "pipeline_runtime_changed" });
  });

  it("pins linked skill document contents in the mission runtime fingerprint", async () => {
    await configureOrganization();
    const createdSkill = await request<{ skill: { id: string } }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "runtime-linked",
        description: "Pinned local reference",
        content: "# Runtime linked\n\n[Reference](reference.md)",
      }),
    });
    const linkedDocument = join(dataDir, "skills", "runtime-linked", "reference.md");
    await writeFile(linkedDocument, "# Contract\n\nVersion one.\n", "utf8");

    const config = await request<any>("/api/config");
    const profiles = config.orchestration.profiles.map((entry: any, profileIndex: number) => ({
      ...entry,
      roles: entry.roles.map((entryRole: any, roleIndex: number) => profileIndex === 0 && roleIndex === 0
        ? {
            ...entryRole,
            skillIds: [createdSkill.skill.id],
            capabilities: [...new Set([...entryRole.capabilities, "skills.read"])],
          }
        : entryRole),
    }));
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: { ...config.orchestration, profiles } }),
    });
    const mission = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Pin linked documentation" }),
    });

    await writeFile(linkedDocument, "# Contract\n\nVersion two.\n", "utf8");
    const start = await response(`/api/pipeline-runs/${mission.run.runId}/start`, {
      method: "POST",
      body: "{}",
    });
    expect(start.status).toBe(409);
    expect(await start.json()).toMatchObject({ code: "pipeline_runtime_changed" });
  });

  it("rejects mission admission when an effective provider is not ready", async () => {
    await configureOrganization();
    const config = await request<any>("/api/config");
    const providers = config.providers.map((provider: any) => provider.id === "test-local"
      ? { ...provider, requiresApiKey: true }
      : provider);
    await request("/api/config", { method: "PUT", body: JSON.stringify({ providers }) });
    const create = await response("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Must have a runnable provider" }),
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({ code: "pipeline_runtime_unavailable" });
  });

  it("rejects unavailable skill ids at the Team config boundary", async () => {
    await configureOrganization();
    const config = await request<any>("/api/config");
    const profiles = config.orchestration.profiles.map((entry: any, profileIndex: number) => ({
      ...entry,
      roles: entry.roles.map((role: any, roleIndex: number) => ({
        ...role,
        skillIds: profileIndex === 0 && roleIndex === 0 ? ["missing-required-skill"] : role.skillIds,
      })),
    }));
    const save = await response("/api/config", {
      method: "PUT",
      body: JSON.stringify({ orchestration: { ...config.orchestration, profiles } }),
    });
    expect(save.status).toBe(400);
    expect(await save.json()).toMatchObject({ code: "team_role_skill_unavailable" });
  });

  it("rejects stale Pipeline saves and workspace drift before mission start", async () => {
    const configured = await configureOrganization();
    const first = await request<any>("/api/pipelines");
    const stale = structuredClone(first);
    first.definitions[0].name = "First edit";
    first.definitions[0].revision += 1;
    await request("/api/pipelines", { method: "PUT", body: JSON.stringify(first) });
    stale.definitions[0].name = "Stale edit";
    stale.definitions[0].revision += 1;
    const staleWrite = await response("/api/pipelines", { method: "PUT", body: JSON.stringify(stale) });
    expect(staleWrite.status).toBe(409);

    const current = await request<any>("/api/pipelines");
    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: current.definitions[0].id, goal: "Detect external edits" }),
    });
    await writeFile(join(configured.workspace, "external-edit.txt"), "changed after mission creation");
    const start = await response(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });
    expect(start.status).toBe(409);
    expect(await start.json()).toMatchObject({ code: "pipeline_workspace_changed" });
  });

  it("fails mission admission when a present strict-required primitive cannot isolate", async () => {
    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({ runKyreiChat: async () => ({ text: "done", parts: [] }), listModels: () => [] }),
      sandboxCapabilityProbe: async (engine: { sandbox?: string }) => ({
        mode: engine.sandbox ?? "off",
        id: engine.sandbox === "strict-required" ? "unusable-test-primitive" : "noop",
        available: engine.sandbox !== "strict-required",
      }),
    });
    await configureOrganization();
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ engine: { sandbox: "strict-required" } }),
    });
    const create = await response("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Must be isolated" }),
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({ code: "sandbox_required_unavailable" });
  });

  it("requires the launch token for mission snapshots", async () => {
    await configureOrganization();
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/pipeline-runs`);
    expect(unauthorized.status).toBe(401);
  });
});
