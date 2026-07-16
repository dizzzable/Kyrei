import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { observeWorkspace } from "../../workspace-evidence.js";
import { executeWorkspaceApply, PipelineActionError } from "./action-executor.js";
import type { ArtifactEnvelope } from "./types.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kyrei-action-exec-"));
  workspaces.push(dir);
  return dir;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function departmentWithPatch(patch: string, workspaceDigest: string): ArtifactEnvelope {
  return {
    schemaVersion: 1,
    id: "impl-artifact",
    kind: "department",
    runId: "run-1",
    stageId: "implementation",
    producerId: "executor-team",
    createdAt: "2026-07-13T10:00:00.000Z",
    summary: "Implementation patch",
    workspaceDigest,
    inputDigests: [],
    assumptions: [],
    uncertainties: [],
    unchecked: [],
    provenance: {
      providerId: "test",
      modelId: "test",
      policyDigest: digest("policy"),
    },
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerCalls: 0,
      durationMs: 0,
    },
    claims: [],
    evidence: [{
      id: "applicable-patch",
      kind: "patch",
      origin: "reported",
      summary: "patch",
      capturedAt: "2026-07-13T10:00:00.000Z",
      workspaceDigest,
      patch,
      patchDigest: digest(patch),
    }],
    checks: [],
    contradictions: [],
  };
}

describe("executeWorkspaceApply", () => {
  it("applies a single patch and returns a valid action receipt", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "hello.txt"), "hello\n", "utf8");
    const baseline = await observeWorkspace(workspace);
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+hello world",
      "*** End Patch",
      "",
    ].join("\n");

    const result = await executeWorkspaceApply({
      run: { workspace, workspaceCheckpointDigest: baseline.digest },
      stage: { id: "apply-changes", workspaceDigestBefore: baseline.digest },
      dependencyArtifacts: {
        "approve-implementation": [departmentWithPatch(patch, baseline.digest)],
      },
    }, { observeWorkspace });

    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello world\n");
    expect(result.actionReceipt.workspaceDigestBefore).toBe(baseline.digest);
    expect(result.actionReceipt.workspaceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.actionReceipt.workspaceDigest).not.toBe(baseline.digest);
    expect(result.actionReceipt.patchDigest).toBe(digest(patch));
    expect(result.actionReceipt.appliedFiles).toEqual(["hello.txt"]);
    expect(result.actionReceipt.observedAt).toEqual(expect.any(String));
  });

  it("fails closed on baseline mismatch without writing", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "hello.txt"), "hello\n", "utf8");
    const baseline = await observeWorkspace(workspace);
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+mutated",
      "*** End Patch",
      "",
    ].join("\n");

    await expect(executeWorkspaceApply({
      run: { workspace },
      stage: { id: "apply-changes", workspaceDigestBefore: "a".repeat(64) },
      dependencyArtifacts: {
        impl: [departmentWithPatch(patch, baseline.digest)],
      },
    }, { observeWorkspace })).rejects.toMatchObject({
      code: "pipeline_action_baseline_mismatch",
    });
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
  });

  it("fails when zero or multiple patch evidences are present", async () => {
    const workspace = await tempWorkspace();
    await mkdir(join(workspace, "sub"), { recursive: true });
    const baseline = await observeWorkspace(workspace);
    await expect(executeWorkspaceApply({
      run: { workspace },
      stage: { id: "apply-changes", workspaceDigestBefore: baseline.digest },
      dependencyArtifacts: { impl: [] },
    }, { observeWorkspace })).rejects.toBeInstanceOf(PipelineActionError);

    const patch = "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch\n";
    const artifact = departmentWithPatch(patch, baseline.digest);
    await expect(executeWorkspaceApply({
      run: { workspace },
      stage: { id: "apply-changes", workspaceDigestBefore: baseline.digest },
      dependencyArtifacts: { a: [artifact], b: [artifact] },
    }, { observeWorkspace })).rejects.toMatchObject({
      code: "pipeline_action_payload_missing",
    });
  });

  it("rolls back on apply failure (context not found)", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "hello.txt"), "hello\n", "utf8");
    const baseline = await observeWorkspace(workspace);
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-not-present",
      "+mutated",
      "*** End Patch",
      "",
    ].join("\n");

    await expect(executeWorkspaceApply({
      run: { workspace },
      stage: { id: "apply-changes", workspaceDigestBefore: baseline.digest },
      dependencyArtifacts: {
        impl: [departmentWithPatch(patch, baseline.digest)],
      },
    }, { observeWorkspace })).rejects.toBeTruthy();
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hello\n");
    const after = await observeWorkspace(workspace);
    expect(after.digest).toBe(baseline.digest);
  });
});
