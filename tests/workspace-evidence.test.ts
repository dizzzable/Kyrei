import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { observeWorkspace, workspacePermissionBits } from "../core/workspace-evidence.js";

const roots: string[] = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "kyrei-workspace-evidence-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("workspace evidence", () => {
  it("normalizes numeric and bigint permission modes to identical evidence", () => {
    expect(workspacePermissionBits(0o40755)).toBe(0o755n);
    expect(workspacePermissionBits(0o40755n)).toBe(0o755n);
    expect(() => workspacePermissionBits(Number.NaN)).toThrow("pipeline_workspace_evidence_metadata_invalid");
  });

  it("changes with source and dependency content by default", async () => {
    const workspace = await root();
    await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
    const first = await observeWorkspace(workspace);
    await writeFile(join(workspace, "source.ts"), "export const value = 2;\n");
    const second = await observeWorkspace(workspace);
    expect(second.digest).not.toBe(first.digest);

    await mkdir(join(workspace, "node_modules"));
    await writeFile(join(workspace, "node_modules", "cache.js"), "one");
    const dependencyFirst = await observeWorkspace(workspace);
    await writeFile(join(workspace, "node_modules", "cache.js"), "two");
    const dependencySecond = await observeWorkspace(workspace);
    expect(dependencySecond.digest).not.toBe(dependencyFirst.digest);
    expect(dependencySecond.excluded).toBe(0);
  });

  it("does not follow a symlink outside the workspace", async () => {
    const workspace = await root();
    const outside = await root();
    await writeFile(join(outside, "secret.txt"), "first");
    const link = join(workspace, "outside-link");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const first = await observeWorkspace(workspace);
    await writeFile(join(outside, "secret.txt"), "second");
    const second = await observeWorkspace(workspace);
    expect(second.digest).toBe(first.digest);
  });

  it("fails closed when configured evidence bounds are exceeded", async () => {
    const workspace = await root();
    await writeFile(join(workspace, "large.txt"), "12345");
    await expect(observeWorkspace(workspace, { maxBytes: 4 }))
      .rejects.toMatchObject({ code: "pipeline_workspace_evidence_limit" });
  });
});
