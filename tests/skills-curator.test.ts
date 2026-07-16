import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heuristicSkillsProposals,
  curateSkills,
  listSkillsCuratorProposals,
  applyStoredSkillsCuratorProposal,
  applySingleSkillsProposal,
  normalizeSkillsCuratorConfig,
  parseLlmSkillSuggestions,
  selectSkillsForLlm,
  DEFAULT_SKILLS_CURATOR_CONFIG,
} from "../core/skills-curator.js";

describe("skills curator", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-skills-cur-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("defaults to disabled propose mode", () => {
    expect(DEFAULT_SKILLS_CURATOR_CONFIG.enabled).toBe(false);
    expect(normalizeSkillsCuratorConfig({}).enabled).toBe(false);
    expect(normalizeSkillsCuratorConfig({ enabled: true, applyMode: "apply_safe" }).applyMode).toBe("apply_safe");
  });

  it("flags stale, never-used, thin description, and duplicates", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const proposals = heuristicSkillsProposals(
      [
        {
          id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
          name: "review",
          description: "short",
          enabled: true,
          usage: 2,
          lastUsedAt: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "skill_bbbbbbbbbbbbbbbbbbbbbbbb",
          name: "review",
          description: "A solid description of when to use this skill for code review.",
          enabled: true,
          usage: 0,
        },
        {
          id: "skill_cccccccccccccccccccccccc",
          name: "hot-one",
          description: "Used recently but currently disabled for some reason.",
          enabled: false,
          usage: 9,
          lastUsedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      { staleDays: 90, maxProposals: 40 },
      { now },
    );

    expect(proposals.some((p) => p.kind === "stale" && p.action === "disable")).toBe(true);
    expect(proposals.some((p) => p.kind === "never_used")).toBe(true);
    expect(proposals.some((p) => p.kind === "thin_description")).toBe(true);
    expect(proposals.filter((p) => p.kind === "duplicate_name").length).toBeGreaterThanOrEqual(2);
    expect(proposals.some((p) => p.kind === "disabled_hot" && p.action === "enable")).toBe(true);
  });

  it("disabled curator does not write proposals", async () => {
    const result = await curateSkills({
      dataDir,
      skills: [{ id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa", name: "x", enabled: true, usage: 0 }],
      skillsStore: { setEnabled: async () => ({}) },
      config: { enabled: false },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("curator_disabled");
  });

  it("propose mode writes proposal file without applying", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const enabled: string[] = [];
    const result = await curateSkills({
      dataDir,
      skills: [
        {
          id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
          name: "old-skill",
          description: "A reasonably long description for matching.",
          enabled: true,
          usage: 1,
          lastUsedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      skillsStore: {
        setEnabled: async (id, on) => {
          if (!on) enabled.push(id);
          return {};
        },
      },
      config: { enabled: true, applyMode: "propose", staleDays: 30 },
      now,
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.proposalPath).toBeTruthy();
    const raw = await readFile(result.proposalPath!, "utf8");
    expect(raw).toContain("old-skill");
    expect(enabled).toEqual([]);
  });

  it("apply_safe disables only stale skills", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const disabled: string[] = [];
    const result = await curateSkills({
      dataDir,
      skills: [
        {
          id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
          name: "stale-skill",
          description: "A reasonably long description for matching.",
          enabled: true,
          usage: 4,
          lastUsedAt: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "skill_bbbbbbbbbbbbbbbbbbbbbbbb",
          name: "fresh",
          description: "A reasonably long description for matching.",
          enabled: true,
          usage: 1,
          lastUsedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      skillsStore: {
        setEnabled: async (id, on) => {
          if (!on) disabled.push(id);
          return {};
        },
      },
      config: { enabled: true, applyMode: "apply_safe", staleDays: 30 },
      now,
    });
    expect(result.ok).toBe(true);
    expect(disabled).toEqual(["skill_aaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(result.applied.length).toBe(1);
  });

  it("defaults LLM layer off", () => {
    expect(DEFAULT_SKILLS_CURATOR_CONFIG.useLlm).toBe(false);
    expect(normalizeSkillsCuratorConfig({ useLlm: true, modelSource: "session" }).modelSource).toBe("session");
  });

  it("parses LLM suggestions and rejects renames", () => {
    const candidates = [
      {
        id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
        name: "review",
        description: "thin",
        enabled: true,
        owned: true,
        content: "---\nname: review\n---\n# body\n",
      },
    ];
    const ok = parseLlmSkillSuggestions(
      JSON.stringify({
        suggestions: [
          {
            skillId: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
            skillName: "review",
            summary: "Clearer trigger",
            suggestedDescription: "Use when reviewing pull requests for correctness and style.",
            suggestedContent: "---\nname: review\ndescription: better\n---\n# Review\n\nSteps...\n",
          },
          {
            skillId: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
            skillName: "review",
            summary: "rename attack",
            suggestedContent: "---\nname: hacked\n---\n# no\n",
          },
        ],
      }),
      candidates,
    );
    expect(ok).toHaveLength(1);
    expect(ok[0].kind).toBe("llm_patch");
    expect(ok[0].action).toBe("suggest_patch");
    expect(ok[0].suggestedDescription).toMatch(/pull requests/i);
  });

  it("selects owned skills with content for LLM", () => {
    const skills = [
      {
        id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
        name: "a",
        enabled: true,
        owned: true,
        content: "# a",
        description: "x",
      },
      {
        id: "skill_bbbbbbbbbbbbbbbbbbbbbbbb",
        name: "b",
        enabled: true,
        owned: false,
        content: "# b",
      },
      {
        id: "skill_cccccccccccccccccccccccc",
        name: "c",
        enabled: true,
        owned: true,
        // no content
      },
    ];
    const heuristic = heuristicSkillsProposals(
      skills.map((s) => ({ ...s, description: s.description ?? "" })),
      { maxProposals: 20 },
    );
    const selected = selectSkillsForLlm(
      skills,
      heuristic,
      normalizeSkillsCuratorConfig({ maxLlmSkills: 4 }),
    );
    expect(selected.map((s) => s.id)).toEqual(["skill_aaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("merges LLM proposals without auto-applying patches", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const updates: string[] = [];
    const result = await curateSkills({
      dataDir,
      skills: [
        {
          id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
          name: "thin-skill",
          description: "short",
          enabled: true,
          owned: true,
          usage: 0,
          content: "---\nname: thin-skill\n---\n# hi\n",
        },
      ],
      skillsStore: {
        setEnabled: async () => ({}),
        update: async (id: string) => {
          updates.push(id);
          return {};
        },
      },
      config: {
        enabled: true,
        applyMode: "apply_safe",
        useLlm: true,
        staleDays: 30,
      },
      now,
      model: {} as never,
      generateText: async () => ({
        text: JSON.stringify({
          suggestions: [
            {
              skillId: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
              skillName: "thin-skill",
              summary: "Better desc",
              suggestedDescription: "Use this skill when the user asks for a thin-skill workflow end to end.",
            },
          ],
        }),
      }) as never,
    });
    expect(result.ok).toBe(true);
    expect(result.via).toBe("llm");
    expect(result.proposals.some((p) => p.kind === "llm_patch")).toBe(true);
    // apply_safe must not write SKILL.md patches
    expect(updates).toEqual([]);
  });

  it("apply_patch writes via skillsStore.update", async () => {
    const calls: Array<{ id: string; patch: unknown }> = [];
    const result = await applySingleSkillsProposal(
      {
        setEnabled: async () => ({}),
        update: async (id, patch) => {
          calls.push({ id, patch });
          return { id, content: "ok" };
        },
      },
      {
        skillId: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
        action: "apply_patch",
        suggestedDescription: "A clear trigger description for this skill.",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.patched).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].patch).toMatchObject({ description: "A clear trigger description for this skill." });
  });

  it("lists proposals and applies stored safe disables", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const disabled: string[] = [];
    const store = {
      setEnabled: async (id: string, on: boolean) => {
        if (!on) disabled.push(id);
        return {};
      },
    };
    const proposed = await curateSkills({
      dataDir,
      skills: [
        {
          id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
          name: "archive-me",
          description: "A reasonably long description for matching.",
          enabled: true,
          usage: 2,
          lastUsedAt: "2024-06-01T00:00:00.000Z",
        },
      ],
      skillsStore: store,
      config: { enabled: true, applyMode: "propose", staleDays: 30 },
      now,
    });
    expect(proposed.fileName).toBeTruthy();
    const listed = await listSkillsCuratorProposals(dataDir, { limit: 10 });
    expect(listed.some((p) => p.fileName === proposed.fileName)).toBe(true);
    const applied = await applyStoredSkillsCuratorProposal(
      dataDir,
      proposed.fileName!,
      "apply_safe",
      store,
    );
    expect(applied.ok).toBe(true);
    expect(disabled).toEqual(["skill_aaaaaaaaaaaaaaaaaaaaaaaa"]);
  });
});
