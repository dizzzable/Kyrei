import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsStore } from "../core/skills-store.js";
import {
  BUILTIN_SKILL_PACKS,
  builtinSkillPacksRoot,
  listSkillPacks,
  enableSkillPack,
  disableSkillPack,
  resolveBuiltinPackPath,
} from "../core/skill-packs.js";

describe("skill packs (Wave C2)", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-packs-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("ships security and research packs on disk", () => {
    expect(BUILTIN_SKILL_PACKS.map((p) => p.id).sort()).toEqual(["research", "security"]);
    expect(builtinSkillPacksRoot()).toContain("skill-packs");
    expect(resolveBuiltinPackPath("security")).toContain("security");
  });

  it("lists packs and enable/disable as custom roots", async () => {
    const store = new SkillsStore({ dataDir, kiroRoot: "" });
    await store.load();
    const before = await listSkillPacks(store);
    expect(before.every((p) => p.available)).toBe(true);
    expect(before.every((p) => !p.enabled)).toBe(true);
    expect(before.find((p) => p.id === "security")?.skillCount).toBeGreaterThanOrEqual(2);

    await enableSkillPack(store, "security");
    const mid = await listSkillPacks(store);
    expect(mid.find((p) => p.id === "security")?.enabled).toBe(true);

    const skills = await store.list();
    expect(skills.some((s) => s.name === "security-checklist")).toBe(true);
    expect(skills.some((s) => s.name === "secret-hygiene")).toBe(true);

    // Second enable is idempotent
    const again = await enableSkillPack(store, "security");
    expect(again.already).toBe(true);

    await disableSkillPack(store, "security");
    const after = await listSkillPacks(store);
    expect(after.find((p) => p.id === "security")?.enabled).toBe(false);
  });
});
