import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { createDefaultCodingPipeline } from "../core/pipeline-config.js";
import { createArtifactEnvelope } from "../core/engine/pipeline/artifacts.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-patch-ingress-"));
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
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const response = await request<{ run: T }>(`/api/pipeline-runs/${runId}`);
    last = response.run;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 30));
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

function samplePatch(): string {
  return "*** Begin Patch\n*** Add File: notes/hello.txt\n+hello world\n*** End Patch\n";
}

describe("pipeline patch ingress (S1)", () => {
  it("embeds applicablePatch as kind:patch evidence without collapsing whitespace", async () => {
    const patch = samplePatch();
    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => ({
        runKyreiChat: async () => ({ text: "done", parts: [] }),
        listModels: () => [],
        runTeamDepartment: async (input: Record<string, unknown>) => {
          const stageId = String(input.stageId);
          const artifact = {
            taskId: `task-${stageId}`,
            summary: `Structured ${stageId} result`,
            provenance: ["model structured response"],
            confidence: 0.8,
            evidence: [`reported ${stageId} evidence`],
            validation: [`reviewed ${stageId}`],
            uncertainties: [],
            whatWasNotChecked: [],
            ...(stageId === "implementation" ? { applicablePatch: patch } : {}),
          };
          return {
            runId: `team-${stageId}`,
            artifact,
            metrics: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              costUsd: 0,
              providerCalls: 1,
              unmeteredProviderCalls: 0,
            },
            taskResults: [{ status: "succeeded", artifact }],
          };
        },
      }),
    });

    const workspace = join(dataDir, "workspace");
    await mkdir(workspace, { recursive: true });
    const profiles = ["research-team", "planning-team", "executor-team", "test-team"].map(profile);
    const definition = createDefaultCodingPipeline({
      research: "research-team",
      planning: "planning-team",
      execution: "executor-team",
      verification: "test-team",
    });
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
        pipelines: { version: 1, definitions: [definition] },
      }),
    });

    const created = await request<{ run: { runId: string } }>("/api/pipeline-runs", {
      method: "POST",
      body: JSON.stringify({ pipelineId: "coding-product", goal: "Ship a patch" }),
    });
    await request(`/api/pipeline-runs/${created.run.runId}/start`, { method: "POST", body: "{}" });

    await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.status === "awaiting_approval",
    );
    await request(`/api/pipeline-runs/${created.run.runId}/approval`, {
      method: "POST",
      body: JSON.stringify({ stageId: "approve-plan", status: "approved", reason: "ok" }),
    });

    const afterImpl = await waitForPipelineRun<any>(
      created.run.runId,
      (run) => run.stages.find((s: any) => s.id === "implementation")?.status === "completed",
    );
    const implArtifact = afterImpl.artifacts.find((a: any) => a.stageId === "implementation");
    expect(implArtifact).toBeTruthy();
    const patchEvidence = implArtifact.evidence.find((e: any) => e.kind === "patch");
    expect(patchEvidence).toMatchObject({
      id: "applicable-patch",
      kind: "patch",
      origin: "reported",
      patch,
      patchDigest: createHash("sha256").update(patch, "utf8").digest("hex"),
    });
    expect(String(patchEvidence.patch)).toContain("\n");
    expect(() => createArtifactEnvelope(implArtifact)).not.toThrow();
  });
});
