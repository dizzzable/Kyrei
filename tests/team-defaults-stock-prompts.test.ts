import { describe, expect, it } from "vitest";

import {
  BUILTIN_PROMPT_PROFILES,
  buildBuiltinCodingTeamProfile,
} from "../core/team-defaults.js";

describe("stock Team prompt contracts", () => {
  it("provides a structured fallback contract for every built-in role", () => {
    expect(BUILTIN_PROMPT_PROFILES.length).toBeGreaterThanOrEqual(4);
    for (const profile of BUILTIN_PROMPT_PROFILES) {
      expect(profile.systemPrompt).toContain("MISSION:");
      expect(profile.systemPrompt).toContain("BOUNDARY:");
      expect(profile.systemPrompt).toContain("HANDOFF:");
    }
  });

  it("uses the profile as the single role source of truth", () => {
    const team = buildBuiltinCodingTeamProfile({ providerId: "openai", modelId: "gpt" });
    expect(team).not.toBeNull();
    expect(team!.roles.every((role: { instructions: string }) => role.instructions === "")).toBe(true);
    expect(team!.roles.every((role: { promptProfileId: string }) => (
      BUILTIN_PROMPT_PROFILES.some((profile) => profile.id === role.promptProfileId)
    ))).toBe(true);
  });
});
