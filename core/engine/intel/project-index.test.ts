import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeProjectImpact,
  buildProjectIndex,
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
});
