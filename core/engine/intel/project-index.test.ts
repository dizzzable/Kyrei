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
    await mkdir(join(workspace, "output", "playwright"), { recursive: true });
    await writeFile(join(workspace, "output", "playwright", "fixture.ts"), "export const fixture = true;\n", "utf8");

    const index = await buildProjectIndex(workspace);

    expect(index.nodes.some((node) => node.path.startsWith("hermes/"))).toBe(false);
    expect(index.nodes.some((node) => node.path.startsWith("output/"))).toBe(false);
  });

  it("incremental: only re-parses changed files on second build", async () => {
    const index1 = await buildProjectIndexIncremental(workspace);
    // 3 source files + package.json (entry candidate, not a graph node)
    expect(index1.fileCount).toBe(4);
    expect(index1.entryCandidates).toContain("package.json");
    expect(index1.edges.length).toBe(2); // entry→service, service→util

    // Modify one file (add new import)
    await writeFile(
      join(workspace, "src", "entry.ts"),
      "import { run } from './service';\nimport { util } from './util';\nrun();\n",
      "utf8"
    );

    const index2 = await buildProjectIndexIncremental(workspace);
    expect(index2.fileCount).toBe(4); // same file count
    expect(index2.edges.length).toBe(3); // now entry→service, entry→util, service→util

    // Verify the new edge exists
    expect(index2.edges.some(e => e.from === "src/entry.ts" && e.to === "src/util.ts")).toBe(true);
  });

  it("incremental: handles deleted files", async () => {
    const index1 = await buildProjectIndexIncremental(workspace);
    expect(index1.fileCount).toBe(4);

    // Delete a file
    await rm(join(workspace, "src", "util.ts"));

    const index2 = await buildProjectIndexIncremental(workspace);
    expect(index2.fileCount).toBe(3); // package.json + entry + service
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

describe("import alias resolution", () => {
  /** Overwrite the fixture's entry so it imports through an alias. */
  async function withAlias(tsconfig: string): Promise<void> {
    await writeFile(join(workspace, "tsconfig.json"), tsconfig, "utf8");
    await writeFile(join(workspace, "src", "entry.ts"), "import { run } from '@/service';\nrun();\n", "utf8");
  }

  it("follows a path alias into the workspace", async () => {
    // Without this, a specifier that does not start with "." was discarded, so
    // an alias-importing layer had NO edges at all. Measured on Kyrei itself:
    // 880 of 8 306 internal imports invisible, every one of them in the
    // renderer — precisely where `project_impact` was least able to answer.
    await withAlias(`{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}`);
    const index = await buildProjectIndex(workspace);

    expect(index.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "src/entry.ts", to: "src/service.ts", provenance: "EXTRACTED" }),
    ]));
    expect(analyzeProjectImpact(index, "src/service.ts").directDependents).toContain("src/entry.ts");
  });

  it("reads a tsconfig that contains comments and a trailing comma", async () => {
    // tsconfig.json is JSONC by convention, so a plain JSON.parse fails on most
    // real projects and would silently leave every alias unresolved.
    await withAlias(`{
      // paths for the renderer
      "compilerOptions": {
        /* wildcard mapping */
        "paths": { "@/*": ["./src/*"], },
      },
    }`);
    const index = await buildProjectIndex(workspace);
    expect(index.edges.some((edge) => edge.from === "src/entry.ts" && edge.to === "src/service.ts")).toBe(true);
  });

  it("honours baseUrl when the mapping is relative to it", async () => {
    await withAlias(`{"compilerOptions":{"baseUrl":"./src","paths":{"@/*":["./*"]}}}`);
    const index = await buildProjectIndex(workspace);
    expect(index.edges.some((edge) => edge.from === "src/entry.ts" && edge.to === "src/service.ts")).toBe(true);
  });

  it("prefers the longest matching prefix", async () => {
    await mkdir(join(workspace, "src", "deep"), { recursive: true });
    await writeFile(join(workspace, "src", "deep", "service.ts"), "export const run = () => 2;\n", "utf8");
    await writeFile(join(workspace, "tsconfig.json"), `{"compilerOptions":{"paths":{"@/*":["./src/*"],"@/service":["./src/deep/service.ts"]}}}`, "utf8");
    await writeFile(join(workspace, "src", "entry.ts"), "import { run } from '@/service';\nrun();\n", "utf8");

    const index = await buildProjectIndex(workspace);
    expect(index.edges.some((edge) => edge.from === "src/entry.ts" && edge.to === "src/deep/service.ts")).toBe(true);
    expect(index.edges.some((edge) => edge.from === "src/entry.ts" && edge.to === "src/service.ts")).toBe(false);
  });

  it("still ignores package imports and unresolvable aliases", async () => {
    await writeFile(join(workspace, "tsconfig.json"), `{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}`, "utf8");
    await writeFile(join(workspace, "src", "entry.ts"), "import React from 'react';\nimport x from '@/does-not-exist';\nexport default [React, x];\n", "utf8");

    const index = await buildProjectIndex(workspace);
    expect(index.edges.filter((edge) => edge.from === "src/entry.ts")).toEqual([]);
  });

  it("resolves nothing when the workspace declares no aliases", async () => {
    await writeFile(join(workspace, "src", "entry.ts"), "import { run } from '@/service';\nrun();\n", "utf8");
    const index = await buildProjectIndex(workspace);
    expect(index.edges.some((edge) => edge.from === "src/entry.ts")).toBe(false);
  });

  it("resolves aliases on the incremental path too", async () => {
    // The two builders duplicate the extraction loop, so an alias fix applied
    // to only one of them would work on a full rebuild and vanish on the next
    // incremental one — which is the path the tool actually calls.
    await withAlias(`{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}`);
    const index = await buildProjectIndexIncremental(workspace);
    expect(index.edges.some((edge) => edge.from === "src/entry.ts" && edge.to === "src/service.ts")).toBe(true);
  });

  it("re-parses when the alias table changes, without any file changing", async () => {
    // Incremental caching keys edges by file CONTENT, so nothing invalidated
    // them when the MEANING of that content changed. Editing tsconfig paths —
    // or shipping a smarter extractor — left every untouched file holding the
    // edges the old rules produced, indefinitely.
    await writeFile(join(workspace, "src", "entry.ts"), "import { run } from '@/service';\nrun();\n", "utf8");
    await writeFile(join(workspace, "tsconfig.json"), `{"compilerOptions":{"paths":{"@/*":["./nowhere/*"]}}}`, "utf8");
    const before = await buildProjectIndexIncremental(workspace);
    expect(before.edges.some((edge) => edge.from === "src/entry.ts")).toBe(false);

    await writeFile(join(workspace, "tsconfig.json"), `{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}`, "utf8");
    const after = await buildProjectIndexIncremental(workspace);
    expect(after.edges.some((edge) => edge.from === "src/entry.ts" && edge.to === "src/service.ts")).toBe(true);
  });
});
