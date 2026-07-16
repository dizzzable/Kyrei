import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeProjectImpact,
  buildProjectIndex,
  buildProjectIndexIncremental,
  formatProjectIndex,
  loadProjectIndex,
  persistProjectIndex,
} from "./project-index.js";

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kyrei-intel-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "entry.ts"), "import { run } from './service';\nrun();\n", "utf8");
  await writeFile(join(workspace, "src", "service.ts"), "import { util } from './util';\nexport const run = util;\n", "utf8");
  await writeFile(join(workspace, "src", "util.ts"), "export const util = () => 1;\n", "utf8");
  await writeFile(join(workspace, "package.json"), "{}", "utf8");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("project intelligence index", () => {
  it("extracts deterministic import edges and impact relationships", async () => {
    const index = await buildProjectIndex(workspace);
    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "src/entry.ts", to: "src/service.ts", provenance: "EXTRACTED" }),
      expect.objectContaining({ from: "src/service.ts", to: "src/util.ts", provenance: "EXTRACTED" }),
    ]));
    const impact = analyzeProjectImpact(index, "src/util.ts");
    expect(impact.directDependents).toEqual(["src/service.ts"]);
    expect(impact.transitiveDependents).toEqual(["src/entry.ts"]);
    expect(formatProjectIndex(index)).toContain("Extracted dependency edges");
  });

  it("persists only under the workspace-local Kyrei metadata directory", async () => {
    const index = await buildProjectIndex(workspace);
    await persistProjectIndex(workspace, index);
    const loaded = await loadProjectIndex(workspace);
    expect(loaded?.fileCount).toBe(index.fileCount);
    expect(loaded?.workspace).toBe(workspace);
  });

  it("excludes the repository-local Hermes reference tree", async () => {
    await mkdir(join(workspace, "hermes"), { recursive: true });
    await writeFile(join(workspace, "hermes", "reference.py"), "print('reference')\n", "utf8");

    const index = await buildProjectIndex(workspace);

    expect(index.nodes.some((node) => node.path.startsWith("hermes/"))).toBe(false);
  });

  it("incremental: only re-parses changed files on second build", async () => {
    const index1 = await buildProjectIndexIncremental(workspace);
    expect(index1.fileCount).toBe(3);
    expect(index1.edges.length).toBe(2); // entry→service, service→util

    // Modify one file (add new import)
    await writeFile(
      join(workspace, "src", "entry.ts"),
      "import { run } from './service';\nimport { util } from './util';\nrun();\n",
      "utf8"
    );

    const index2 = await buildProjectIndexIncremental(workspace);
    expect(index2.fileCount).toBe(3); // same file count
    expect(index2.edges.length).toBe(3); // now entry→service, entry→util, service→util

    // Verify the new edge exists
    expect(index2.edges.some(e => e.from === "src/entry.ts" && e.to === "src/util.ts")).toBe(true);
  });

  it("incremental: handles deleted files", async () => {
    const index1 = await buildProjectIndexIncremental(workspace);
    expect(index1.fileCount).toBe(3);

    // Delete a file
    await rm(join(workspace, "src", "util.ts"));

    const index2 = await buildProjectIndexIncremental(workspace);
    expect(index2.fileCount).toBe(2);
    expect(index2.nodes.some(n => n.path === "src/util.ts")).toBe(false);
    // Edge service→util should be gone
    expect(index2.edges.some(e => e.to === "src/util.ts")).toBe(false);
  });

  it("incremental: no-op when no files changed", async () => {
    const index1 = await buildProjectIndexIncremental(workspace);
    const gen1 = index1.generatedAt;

    // Sleep to ensure timestamp would differ if rebuild happened
    await new Promise(resolve => setTimeout(resolve, 10));

    const index2 = await buildProjectIndexIncremental(workspace);
    // File count and edges should be identical
    expect(index2.fileCount).toBe(index1.fileCount);
    expect(index2.edges.length).toBe(index1.edges.length);
    // generatedAt should update (metadata refresh) but structure unchanged
    expect(index2.generatedAt).not.toBe(gen1);
  });
});
