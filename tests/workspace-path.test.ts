import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateWorkspacePath } from "../electron/workspace-path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kyrei-workspace-path-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  return { root, workspace };
}

describe("desktop workspace path validation", () => {
  it("returns the canonical absolute path for an existing directory", async () => {
    const { workspace } = await fixture();
    expect(await validateWorkspacePath(workspace)).toBe(await realpath(workspace));
  });

  it("rejects relative, missing, file, NUL and filesystem-root inputs", async () => {
    const { root } = await fixture();
    const file = join(root, "file.txt");
    await writeFile(file, "not a directory");

    await expect(validateWorkspacePath("relative/project")).rejects.toMatchObject({ code: "workspace_path_invalid" });
    await expect(validateWorkspacePath(join(root, "missing"))).rejects.toMatchObject({ code: "workspace_path_unavailable" });
    await expect(validateWorkspacePath(file)).rejects.toMatchObject({ code: "workspace_path_not_directory" });
    await expect(validateWorkspacePath(`${root}\0escape`)).rejects.toMatchObject({ code: "workspace_path_invalid" });
    await expect(validateWorkspacePath(`${root}\nchild`)).rejects.toMatchObject({ code: "workspace_path_invalid" });
    await expect(validateWorkspacePath(` ${root}`)).rejects.toMatchObject({ code: "workspace_path_invalid" });
    await expect(validateWorkspacePath(parse(root).root)).rejects.toMatchObject({ code: "workspace_path_root_forbidden" });
  });
});
