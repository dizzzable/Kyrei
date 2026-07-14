import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSkillFrontmatter, SkillsStore, SkillsStoreError } from "../core/skills-store.js";

let root: string;
let dataDir: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kyrei-skills-"));
  dataDir = join(root, "data");
  workspace = join(root, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(directory: string, name: string, description = "description") {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
}

describe("SkillsStore discovery and durable state", () => {
  it("discovers the read-only Kiro root and exposes only safe linked-doc metadata publicly", async () => {
    const kiroRoot = join(root, ".kiro");
    const skillDirectory = join(kiroRoot, "skills", "official-react");
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await mkdir(join(kiroRoot, "docs", "react-official"), { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: official-react\ndescription: Read official React docs\n---\n\nRead [local map](references/index.md) and [source](../../docs/react-official/source.md). Ignore [escape](../../outside.md).\n`, "utf8");
    await writeFile(join(skillDirectory, "references", "index.md"), "# Local map", "utf8");
    await writeFile(join(kiroRoot, "docs", "react-official", "source.md"), "# Official source", "utf8");
    await writeFile(join(kiroRoot, "outside.md"), "must not be reachable", "utf8");

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "official-react")!;
    expect(skill).toMatchObject({ provenance: "kiro", owned: false });
    expect(skill.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "local map", relativePath: "references/index.md", source: "skill" }),
      expect.objectContaining({ label: "source", relativePath: "react-official/source.md", source: "kiro-docs" }),
    ]));
    expect(skill.references).toHaveLength(2);
    expect(JSON.stringify(skill.references)).not.toContain("Official source");
    await expect(store.delete(skill.id)).rejects.toMatchObject({ code: "root_not_owned" });

    const runtime = await store.runtimeSkills({ ids: [skill.id] });
    expect(runtime.skills[0]?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "local map", source: "skill" }),
      expect.objectContaining({ label: "source", source: "kiro-docs" }),
    ]));
    expect(JSON.stringify(runtime.skills[0]?.documents)).not.toContain("# Local map");
    const source = skill.references.find((reference: { label: string }) => reference.label === "source");
    await expect(store.readRuntimeDocument(skill.id, source.id)).resolves.toMatchObject({
      id: source.id,
      content: "# Official source",
    });
    expect(JSON.stringify(runtime.skills[0]?.documents)).not.toContain("must not be reachable");
  });

  it("expands one bounded Kiro index level and lazily reads linked MDX leaves", async () => {
    const kiroRoot = join(root, ".kiro-index");
    const skillDirectory = join(kiroRoot, "skills", "official-react");
    const references = join(skillDirectory, "references");
    const docs = join(kiroRoot, "docs", "react", "reference");
    await mkdir(references, { recursive: true });
    await mkdir(docs, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: official-react\n---\n\n[index](references/index.md)\n`, "utf8");
    await writeFile(join(references, "index.md"), "# Index\n\n[useState](../../../docs/react/reference/use-state.mdx)\n\n```md\n[fake](../../../docs/react/reference/ignored.mdx)\n```\n", "utf8");
    await writeFile(join(docs, "use-state.mdx"), "# useState\n\nExact local reference.", "utf8");
    await writeFile(join(docs, "ignored.mdx"), "must stay outside", "utf8");

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "official-react")!;
    const index = skill.references.find((reference: { label: string }) => reference.label === "index")!;
    const leaf = skill.references.find((reference: { label: string }) => reference.label === "useState")!;
    expect(leaf).toMatchObject({
      source: "kiro-docs",
      relativePath: "react/reference/use-state.mdx",
      parentId: index.id,
    });
    const runtime = await store.runtimeSkills({ ids: [skill.id] });
    expect(JSON.stringify(runtime.skills[0]?.documents)).not.toContain("Exact local reference");
    await expect(store.readRuntimeDocument(skill.id, leaf.id)).resolves.toMatchObject({
      content: "# useState\n\nExact local reference.",
    });
    await expect(store.readRuntimeDocument(skill.id, "doc_000000000000000000000000")).resolves.toBeNull();
    expect(skill.references.some((reference: { label: string }) => reference.label === "fake")).toBe(false);
  });

  it("builds a deterministic content identity for SKILL.md, linked indexes, and lazy leaves", async () => {
    const kiroRoot = join(root, ".kiro-identity");
    const skillDirectory = join(kiroRoot, "skills", "identity-skill");
    const references = join(skillDirectory, "references");
    const docs = join(kiroRoot, "docs", "identity");
    await mkdir(references, { recursive: true });
    await mkdir(docs, { recursive: true });
    const skillFile = join(skillDirectory, "SKILL.md");
    const indexFile = join(references, "index.md");
    const leafFile = join(docs, "leaf.md");
    await writeFile(skillFile, `---\nname: identity-skill\n---\n\n[index](references/index.md)\n`, "utf8");
    await writeFile(indexFile, "# Index\n\n[leaf](../../../docs/identity/leaf.md)\n", "utf8");
    await writeFile(leafFile, "leaf content one", "utf8");

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "identity-skill")!;
    const first = await store.runtimeIdentity({ ids: [skill.id] });
    expect(first).toMatchObject({ version: 1, complete: true });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.skills[0]).toMatchObject({
      id: skill.id,
      enabled: true,
      available: true,
      documents: [
        expect.objectContaining({ available: true, digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ available: true, digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ],
    });
    expect(JSON.stringify(first)).not.toContain("leaf content one");

    await writeFile(leafFile, "leaf content two", "utf8");
    const afterLeaf = await store.runtimeIdentity({ ids: [skill.id] });
    expect(afterLeaf.digest).not.toBe(first.digest);

    await writeFile(indexFile, "# Renamed index\n\n[leaf](../../../docs/identity/leaf.md)\n", "utf8");
    const afterIndex = await store.runtimeIdentity({ ids: [skill.id] });
    expect(afterIndex.digest).not.toBe(afterLeaf.digest);

    await writeFile(skillFile, `---\nname: identity-skill\n---\n\nUpdated instructions.\n\n[index](references/index.md)\n`, "utf8");
    const afterSkill = await store.runtimeIdentity({ ids: [skill.id] });
    expect(afterSkill.digest).not.toBe(afterIndex.digest);
  });

  it("marks missing linked documents and runtime identity budgets as incomplete", async () => {
    const kiroRoot = join(root, ".kiro-incomplete-identity");
    const skillDirectory = join(kiroRoot, "skills", "incomplete-skill");
    const references = join(skillDirectory, "references");
    const docs = join(kiroRoot, "docs", "identity");
    await mkdir(references, { recursive: true });
    await mkdir(docs, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: incomplete-skill\n---\n\n[index](references/index.md)\n`, "utf8");
    await writeFile(join(references, "index.md"), "[leaf](../../../docs/identity/leaf.md)\n", "utf8");
    const leafFile = join(docs, "leaf.md");
    await writeFile(leafFile, "temporary leaf", "utf8");

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "incomplete-skill")!;
    await rm(leafFile);
    const missing = await store.runtimeIdentity({ ids: [skill.id] });
    expect(missing.complete).toBe(false);
    expect(missing.skills[0]).toMatchObject({ available: false, error: "runtime_identity_incomplete" });
    expect(missing.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: skill.id, code: "document_unavailable" }),
    ]));

    const bounded = await store.runtimeIdentity({ ids: [skill.id], maxBytes: 1 });
    expect(bounded.complete).toBe(false);
    expect(bounded.bytes).toBe(0);
    expect(bounded.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: skill.id, code: "identity_byte_limit" }),
    ]));
    const missingSkillId = skill.id === "skill_000000000000000000000000"
      ? "skill_111111111111111111111111"
      : "skill_000000000000000000000000";
    await expect(store.runtimeIdentity({ ids: [skill.id, missingSkillId], maxSkills: 1 }))
      .rejects.toMatchObject({ code: "runtime_identity_skill_limit" });
  });

  it("does not expand linked indexes for disabled skills", async () => {
    const kiroRoot = join(root, ".kiro-disabled-identity");
    const skillDirectory = join(kiroRoot, "skills", "disabled-skill");
    const references = join(skillDirectory, "references");
    await mkdir(references, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: disabled-skill\n---\n\n[index](references/index.md)\n`, "utf8");
    const indexFile = join(references, "index.md");
    await writeFile(indexFile, "[leaf](leaf.md)\n", "utf8");
    await writeFile(join(references, "leaf.md"), "must remain unread", "utf8");

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "disabled-skill")!;
    expect(skill.references.length).toBeGreaterThan(0);
    await store.setEnabled(skill.id, false);
    await rm(indexFile);

    const disabled = (await store.list()).find((candidate) => candidate.id === skill.id)!;
    expect(disabled).toMatchObject({ enabled: false, references: [] });
    const identity = await store.runtimeIdentity({ ids: [skill.id] });
    expect(identity).toMatchObject({ complete: false });
    expect(identity.skills[0]).toMatchObject({
      id: skill.id,
      enabled: false,
      available: false,
      documents: [],
      error: "skill_disabled",
    });
    expect(JSON.stringify(identity)).not.toContain("must remain unread");
  });

  it("creates global and workspace roots and discovers only root/immediate-child SKILL.md files", async () => {
    const store = new SkillsStore({ dataDir, workspace });
    await store.load();

    const globalRoot = join(dataDir, "skills");
    const workspaceRoot = join(workspace, ".kyrei", "skills");
    expect((await lstat(globalRoot)).isDirectory()).toBe(true);
    expect((await lstat(workspaceRoot)).isDirectory()).toBe(true);

    await writeSkill(globalRoot, "global-root");
    await writeSkill(join(globalRoot, "child"), "child");
    await writeSkill(join(globalRoot, "group", "nested"), "nested");
    await writeSkill(join(workspaceRoot, "project"), "project");

    const skills = await store.list();
    expect(skills.map((skill) => skill.name)).toEqual(["project", "child", "global-root"]);
    expect(skills.find((skill) => skill.name === "project")).toMatchObject({ provenance: "workspace", owned: true });
    expect(skills.find((skill) => skill.name === "global-root")?.relativePath).toBe("SKILL.md");
  });

  it("keeps stable public ids, enabled state, and usage counters across reloads", async () => {
    const first = new SkillsStore({ dataDir, workspace });
    await first.load();
    const created = await first.create({ name: "durable", description: "Persist me", content: "# Durable" });
    await first.setEnabled(created.id, false);
    await first.recordUsage(created.id, 3);

    const second = new SkillsStore({ dataDir, workspace });
    await second.load();
    const restored = (await second.list()).find((skill) => skill.name === "durable");
    expect(restored).toMatchObject({ id: created.id, enabled: false, usage: 3, provenance: "global" });
    expect(restored?.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const state = JSON.parse(await readFile(join(dataDir, "skills-state.json"), "utf8"));
    expect(state.disabledIds).toContain(created.id);
    expect(state.usage[created.id].total).toBe(3);
    expect((await readdir(dataDir)).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("supports unlimited independent custom roots without taking ownership", async () => {
    const store = new SkillsStore({ dataDir });
    await store.load();
    const customRoots = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const path = join(root, `custom-${index}`);
      await writeSkill(join(path, `skill-${index}`), `custom-${index}`);
      return path;
    }));
    const configured = [];
    for (const path of customRoots) configured.push(await store.addRoot(path));
    expect(configured).toHaveLength(6);
    expect((await store.list()).filter((skill) => skill.provenance === "custom")).toHaveLength(6);

    const customSkill = (await store.list()).find((skill) => skill.name === "custom-0")!;
    await expect(store.delete(customSkill.id)).rejects.toMatchObject({ code: "root_not_owned" });
    await store.removeRoot(configured[0]!.id);
    expect((await store.list()).some((skill) => skill.name === "custom-0")).toBe(false);
    expect((await lstat(customRoots[0]!)).isDirectory()).toBe(true);
  });
});

describe("SkillsStore safety and owned mutations", () => {
  it("creates, reads, and deletes skills only in owned roots", async () => {
    const store = new SkillsStore({ dataDir, workspace });
    await store.load();
    const created = await store.create({
      name: "project-skill",
      description: "Project instructions",
      content: "Use the focused tests.",
      rootId: "workspace",
      metadata: { tags: ["test", "project"] },
    });
    expect(created).toMatchObject({ name: "project-skill", provenance: "workspace", owned: true });
    expect((await store.get(created.id)).content).toContain("Use the focused tests.");
    expect((await store.get(created.id)).metadata.tags).toEqual(["test", "project"]);

    await store.delete(created.id);
    await expect(store.get(created.id)).rejects.toMatchObject({ code: "skill_not_found" });
  });

  it("rejects invalid names, path escapes, relative custom roots, and overlapping roots", async () => {
    const store = new SkillsStore({ dataDir, workspace });
    await store.load();
    for (const name of ["../escape", "two words", "CON", "", ".hidden"]) {
      await expect(store.create({ name })).rejects.toBeInstanceOf(SkillsStoreError);
    }
    await expect(store.addRoot("relative/path")).rejects.toMatchObject({ code: "invalid_root" });
    await expect(store.addRoot(join(dataDir, "skills"))).rejects.toMatchObject({ code: "root_overlap" });
  });

  it("skips symlinked skill directories and rejects symlink roots when the platform permits links", async () => {
    const store = new SkillsStore({ dataDir });
    await store.load();
    const outside = join(root, "outside");
    await writeSkill(outside, "outside");
    const linkedChild = join(dataDir, "skills", "linked");
    const linkedRoot = join(root, "linked-root");
    try {
      await symlink(outside, linkedChild, process.platform === "win32" ? "junction" : "dir");
      await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    expect((await store.list()).some((skill) => skill.name === "outside")).toBe(false);
    await expect(store.addRoot(linkedRoot)).rejects.toMatchObject({ code: "invalid_root" });
  });

  it("blocks symlinked Kiro roots and linked documents", async () => {
    const outside = join(root, "kiro-outside");
    const linkedKiro = join(root, ".kiro-linked");
    await writeSkill(join(outside, "skills", "outside"), "outside");
    await mkdir(join(outside, "docs"), { recursive: true });
    try {
      await symlink(outside, linkedKiro, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    const store = new SkillsStore({ dataDir, kiroRoot: linkedKiro });
    await store.load();
    expect((await store.roots()).find((candidate) => candidate.provenance === "kiro")).toMatchObject({ available: false });
    expect((await store.list()).some((skill) => skill.name === "outside")).toBe(false);
  });

  it("keeps Kiro skills available but rejects a symlinked docs root", async () => {
    const kiroRoot = join(root, ".kiro-docs-link");
    const outsideDocs = join(root, "outside-docs-root");
    const skillDirectory = join(kiroRoot, "skills", "linked-docs");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(outsideDocs, { recursive: true });
    await writeFile(join(outsideDocs, "secret.md"), "outside secret", "utf8");
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: linked-docs\n---\n\n[secret](../../docs/secret.md)\n`, "utf8");
    try {
      await symlink(outsideDocs, join(kiroRoot, "docs"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "linked-docs");
    expect(skill).toBeDefined();
    expect(skill?.references).toEqual([]);
    expect(JSON.stringify(await store.runtimeSkills({ ids: [skill!.id] }))).not.toContain("outside secret");
  });

  it("rejects symlinked files and intermediate directories inside linked-document roots", async () => {
    const kiroRoot = join(root, ".kiro-contained-links");
    const skillDirectory = join(kiroRoot, "skills", "contained-links");
    const docsRoot = join(kiroRoot, "docs");
    const outside = join(root, "outside-contained-links");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(docsRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "outside secret", "utf8");
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: contained-links\n---\n\n[file](../../docs/file.md) [nested](../../docs/nested/secret.md)\n`, "utf8");
    try {
      await symlink(join(outside, "secret.md"), join(docsRoot, "file.md"), "file");
      await symlink(outside, join(docsRoot, "nested"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    const store = new SkillsStore({ dataDir, kiroRoot });
    await store.load();
    const skill = (await store.list()).find((candidate) => candidate.name === "contained-links");
    expect(skill?.references).toEqual([]);
    expect(JSON.stringify(await store.runtimeSkills({ ids: [skill!.id] }))).not.toContain("outside secret");
  });

  it.each([".kyrei", "skills"] as const)(
    "rejects a pre-existing workspace %s symlink without creating directories through it",
    async (component) => {
      const outside = join(root, `outside-preexisting-${component.replace(".", "")}`);
      await mkdir(outside);
      const kyreiRoot = join(workspace, ".kyrei");
      if (component === "skills") await mkdir(kyreiRoot);
      const linkedPath = component === ".kyrei" ? kyreiRoot : join(kyreiRoot, "skills");
      await symlink(outside, linkedPath, process.platform === "win32" ? "junction" : "dir");

      const store = new SkillsStore({ dataDir, workspace });
      await expect(store.load()).rejects.toMatchObject({ code: "invalid_workspace" });
      await expect(lstat(join(outside, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([".kyrei", "skills"] as const)(
    "drops ownership when workspace %s is replaced by a symlink and never deletes its target",
    async (component) => {
      const store = new SkillsStore({ dataDir, workspace });
      await store.load();
      const created = await store.create({ name: "local", rootId: "workspace", content: "Local only" });
      const kyreiRoot = join(workspace, ".kyrei");
      const linkedPath = component === ".kyrei" ? kyreiRoot : join(kyreiRoot, "skills");
      await rm(linkedPath, { recursive: true, force: true });

      const outside = join(root, `outside-replaced-${component.replace(".", "")}`);
      const outsideSkills = component === ".kyrei" ? join(outside, "skills") : outside;
      await writeSkill(join(outsideSkills, "trap"), "trap");
      await symlink(outside, linkedPath, process.platform === "win32" ? "junction" : "dir");

      const workspaceRoot = (await store.roots()).find((candidate) => candidate.provenance === "workspace");
      expect(workspaceRoot).toMatchObject({ owned: false, available: false });
      expect((await store.list()).some((skill) => skill.name === "trap")).toBe(false);
      await expect(store.create({ name: "escaped", rootId: "workspace" })).rejects.toMatchObject({
        code: "root_not_owned",
      });
      await expect(store.delete(created.id)).rejects.toMatchObject({ code: "skill_not_found" });
      await expect(readFile(join(outsideSkills, "trap", "SKILL.md"), "utf8")).resolves.toContain("name: trap");
    },
  );
});

describe("frontmatter and runtime aggregation", () => {
  it("parses only inert allowlisted metadata without prototype pollution", () => {
    const parsed = parseSkillFrontmatter(`---
name: safe-skill
description: >
  Useful project
  guidance
tags: [one, "two"]
__proto__: polluted
constructor: bad
author: !!js/function function(){}
---
# Body`);
    expect(parsed.metadata).toEqual({
      name: "safe-skill",
      description: "Useful project guidance",
      tags: ["one", "two"],
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.body).toContain("# Body");
  });

  it("returns an enabled-only aggregate bounded by skill and character budgets", async () => {
    const store = new SkillsStore({ dataDir, workspace });
    await store.load();
    const one = await store.create({ name: "one", content: "A".repeat(120) });
    const two = await store.create({ name: "two", content: "B".repeat(120) });
    const three = await store.create({ name: "three", content: "C".repeat(120) });
    await store.setEnabled(three.id, false);
    await store.recordUsage(two.id, 5);

    const byCount = await store.runtimeSkills({ maxSkills: 1, maxChars: 10_000 });
    expect(byCount.included).toBe(1);
    expect(byCount.skills[0]?.id).toBe(two.id);
    expect(byCount.truncated).toBe(true);

    const byChars = await store.runtimeSkills({ ids: [one.id, two.id], maxSkills: 10, maxChars: 250 });
    expect(byChars.text.length).toBeLessThanOrEqual(250);
    expect(byChars.skills.every((skill) => skill.enabled)).toBe(true);
    expect(byChars.truncated).toBe(true);
  });
});
