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
