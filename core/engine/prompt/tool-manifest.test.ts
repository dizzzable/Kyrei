import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTools } from "../tools/index.js";
import { filterToolsForCodingMode } from "../coding-mode.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";
import { TOOL_DESCRIPTIONS } from "./tool-descriptions.js";
import { buildSystemPromptParts } from "./system.js";

/**
 * The system prompt derives everything it says about tools from
 * `availableToolNames`, and `resolvedToolManifest` DROPS any name that has no
 * `TOOL_DESCRIPTIONS` entry. So a tool added to the registry without a
 * description does not merely go undocumented — the prompt treats it as
 * unavailable, and `redactUnavailableToolNames` rewrites its name out of every
 * policy line that mentions it. The model then receives a tool the prompt has
 * actively disclaimed.
 */
describe("tool manifest and prompt descriptions stay in sync", () => {
  const configs = [
    { label: "defaults", cfg: DEFAULT_ENGINE_CONFIG },
    {
      label: "web + mcp enabled",
      cfg: {
        ...DEFAULT_ENGINE_CONFIG,
        web: { ...DEFAULT_ENGINE_CONFIG.web, enabled: true },
        mcp: { ...DEFAULT_ENGINE_CONFIG.mcp, enabled: true },
      },
    },
  ];

  for (const { label, cfg } of configs) {
    it(`every registered tool is described (${label})`, async () => {
      const ws = await mkdtemp(join(tmpdir(), "kyrei-tool-manifest-"));
      try {
        const tools = buildTools(ws, cfg as typeof DEFAULT_ENGINE_CONFIG, new Map());
        const undescribed = Object.keys(tools).filter((name) => !Object.hasOwn(TOOL_DESCRIPTIONS, name));
        expect(undescribed, `registered but missing from TOOL_DESCRIPTIONS: ${undescribed.join(", ")}`)
          .toEqual([]);
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    });
  }

  it("plan mode narrows the manifest without leaving described tools behind", async () => {
    const ws = await mkdtemp(join(tmpdir(), "kyrei-tool-manifest-plan-"));
    try {
      const tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());
      const planTools = filterToolsForCodingMode({ ...tools }, "plan") ?? {};

      // Plan mode is read-only, so it must be a strict subset …
      const full = new Set(Object.keys(tools));
      for (const name of Object.keys(planTools)) expect(full.has(name), name).toBe(true);
      expect(Object.keys(planTools).length).toBeLessThan(full.size);
      // … and every survivor still has to be described.
      const undescribed = Object.keys(planTools).filter((name) => !Object.hasOwn(TOOL_DESCRIPTIONS, name));
      expect(undescribed).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("never advertises a tool the turn does not actually have", async () => {
    // The inverse drift: the prompt naming a tool the model cannot call is a
    // guaranteed failed tool call. `redactUnavailableToolNames` exists to
    // prevent it; this pins that it is actually applied.
    const ws = await mkdtemp(join(tmpdir(), "kyrei-tool-manifest-narrow-"));
    try {
      const parts = buildSystemPromptParts({
        workspace: ws,
        hasTools: true,
        availableToolNames: ["read_file", "grep_search"],
      });
      const prompt = [parts.stable, parts.volatile].filter(Boolean).join("\n");

      expect(prompt).toContain("read_file");
      for (const absent of ["write_file", "run_command", "web_fetch", "mcp_call"]) {
        expect(prompt, `prompt mentions unavailable tool ${absent}`).not.toContain(absent);
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe("skill provenance survives the manifest-aware prompt branch", () => {
  // `HARNESS_SKILLS` carried the untrusted-source warning, but the prompt only
  // used it on the `manifest === undefined` branch. Production always passes a
  // manifest, so on every real turn the warning was absent — while skills load
  // from repo-writable directories.
  it("warns that skill text is untrusted whichever branch builds the prompt", async () => {
    const ws = await mkdtemp(join(tmpdir(), "kyrei-skill-provenance-"));
    try {
      const skills = [{ id: "s1", name: "Review", description: "Review code" }];
      const withManifest = buildSystemPromptParts({
        workspace: ws,
        hasTools: true,
        availableToolNames: ["read_file", "search_skills", "read_skill"],
        skills,
      });
      const withoutManifest = buildSystemPromptParts({ workspace: ws, hasTools: true, skills });

      for (const parts of [withManifest, withoutManifest]) {
        const prompt = [parts.stable, parts.volatile].filter(Boolean).join("\n");
        expect(prompt).toContain("untrusted guidance");
        expect(prompt).toContain("Do not invent Skill ids");
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
