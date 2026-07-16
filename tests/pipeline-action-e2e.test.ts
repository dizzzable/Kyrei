/**
 * End-to-end: implementation applicablePatch → approvals → workspace.apply
 * → verification department → trusted truth-gate → mission completed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import {
  createDefaultCodingPipeline,
  normalizePipelines,
  validatePipelinesInput,
} from "../core/pipeline-config.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };

const teamLimits = {
  maxParallel: 2,
  maxDepth: 1,
  maxAgents: 8,
  maxTasks: 8,
  maxStepsPerAgent: 6,
  timeoutMs: 120_000,
};

const PATCH = [
  "*** Begin Patch",
  "*** Add File: notes/hello.txt",
  "+hello from pipeline e2e",
  "*** End Patch",
  "",
].join("\n");

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

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-pipeline-e2e-"));
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => {
      const engine = await import("../core/engine/.dist/index.mjs");
      return {
        ...engine,
        runTeamDepartment: async (input: Record<string, unknown>) => {
          const stageId = String(input.stageId);
          const artifact = {
            taskId: `task-${stageId}`,
            summary: `Structured ${stageId} result for e2e`,
            provenance: ["model structured response"],
            confidence: 0.9,
            evidence: [`reported ${stageId} evidence`],
            validation: [`reviewed ${stageId}`],
            uncertainties: [],
            whatWasNotChecked: [],
            ...(stageId === "implementation" ? { applicablePatch: PATCH } : {}),
          };
          return {
            runId: `team-${stageId}`,
            artifact,
            metrics: {
              inputTokens: 3,
              outputTokens: 2,
              totalTokens: 5,
              costUsd: 0,
              providerCalls: 1,
              unmeteredProviderCalls: 0,
            },
            taskResults: [{ status: "succeeded", artifact }],
          };
        },
      };
    },
  });
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  const body = await result.json() as T & { error?: string; code?: string };
  if (!result.ok) throw new Error(body.code ?? body.error ?? String(result.status));
  return body;
}

async function waitForPipelineRun<T extends { status: string }>(
  runId: string,
  predicate: (run: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const response = await request<{ run: T }>(`/api/pipeline-runs/${runId}`);
    last = response.run;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`pipeline did not reach the expected state: ${JSON.stringify(last, null, 2)}`);
}

function stage(run: any, id: string) {
  return run.stages.find((s: any) => s.id === id);
}

describe("pipeline action executor e2e", () => {
  it("applies implementation patch and completes trusted truth-gate", async () => {
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace, { recursive: true });
    // Seed a tiny node project so readdir/detectEcosystem is happy if checks fall back.
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "e2e", private: true }), "utf8");

    const profiles = ["research-team", "planning-team", "executor-team", "test-team"].map(profile);
    const definition = createDefaultCodingPipeline({
      research: "research-team",
      planning: "planning-team",
      execution: "executor-team",
      verification: "test-team",
    });
    // Deterministic, sandbox-free check for CI (not real npm test).
    const acceptance = definition.stages.find((s) => s.id === "acceptance")!;
    acceptance.checks = [{
      id: "unit",
      command: "node -e \"process.exit(0)\"",
      ecosystem: "node",
    }];
    const pipelines = validatePipelinesInput(
      { version: 1, definitions: [definition] },
      profiles,
    );

    await request("/api/config", {
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
        orchestration: { defaultMode: "single", activeProfileId: "", profiles },
        pipelines,
      }),
    });

    // Sanity: normalized default path still valid
    expect(normalizePipelines(pipelines, profiles).definitions[0]?.enabled).toBe(true);

    const created = await request<{ run: { runId: string; workspace: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Ship hello.txt via pipeline" }),
    });
    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });

    // approve-plan
    await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.status === "awaiting_approval" && stage(run, "planning")?.status === "completed",
    );
    await request(`/api/pipeline-runs/${created.run.runId}/approval`, {
      method: "POST",
      body: JSON.stringify({ stageId: "approve-plan", status: "approved", reason: "plan ok" }),
    });

    // approve-implementation (patch present)
    const beforeImplApprove = await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.status === "awaiting_approval" && stage(run, "implementation")?.status === "completed",
    );
    const implArtifact = beforeImplApprove.artifacts.find((a: any) => a.stageId === "implementation");
    expect(implArtifact?.evidence?.some((e: any) => e.kind === "patch")).toBe(true);

    await request(`/api/pipeline-runs/${created.run.runId}/approval`, {
      method: "POST",
      body: JSON.stringify({ stageId: "approve-implementation", status: "approved", reason: "diff ok" }),
    });

    const completed = await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.status === "completed"
        || stage(run, "acceptance")?.status === "failed"
        || stage(run, "apply-changes")?.status === "failed"
        || stage(run, "apply-changes")?.status === "uncertain",
      20_000,
    );

    expect(stage(completed, "apply-changes")).toMatchObject({ status: "completed" });
    expect(stage(completed, "apply-changes").actionReceipt).toMatchObject({
      workspaceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      workspaceDigestBefore: expect.stringMatching(/^[a-f0-9]{64}$/),
      patchDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      appliedFiles: expect.arrayContaining(["notes/hello.txt"]),
    });
    expect(stage(completed, "verification")?.status).toBe("completed");
    expect(stage(completed, "acceptance")).toMatchObject({ status: "completed" });
    expect(stage(completed, "acceptance").truthGateReceipt).toMatchObject({
      workspaceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      actionReceiptDigests: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect(completed.status).toBe("completed");

    const written = await readFile(join(workspace, "notes", "hello.txt"), "utf8");
    expect(written).toContain("hello from pipeline e2e");
  });

});
