import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROMPT_PROFILES,
  BUILTIN_TEAM_PROFILE_ID,
  buildBuiltinCodingTeamProfile,
  ensureBuiltinPromptProfiles,
  ensureBuiltinTeamOrchestration,
} from "./team-defaults.js";

describe("team-defaults OOB seed", () => {
  it("builds a three-role coding team on a ready model", () => {
    const team = buildBuiltinCodingTeamProfile({ providerId: "openai", modelId: "gpt" });
    expect(team?.id).toBe(BUILTIN_TEAM_PROFILE_ID);
    expect(team?.roles.map((r) => r.id)).toEqual(["researcher", "critic", "architect"]);
    expect(team?.roles.every((r) => r.capabilities.includes("memory.read"))).toBe(true);
    expect(team?.roles.every((r) => r.model?.modelId === "gpt")).toBe(true);
    expect(team?.roles.every((r) => r.instructions === "")).toBe(true);
    expect(team?.roles.every((r) => (
      BUILTIN_PROMPT_PROFILES.some((profile) => profile.id === r.promptProfileId)
    ))).toBe(true);
    expect(buildBuiltinCodingTeamProfile(null)).toBeNull();
  });

  it("ships structured stock role contracts when the user has not supplied one", () => {
    expect(BUILTIN_PROMPT_PROFILES.length).toBeGreaterThanOrEqual(4);
    for (const profile of BUILTIN_PROMPT_PROFILES) {
      expect(profile.systemPrompt).toContain("MISSION:");
      expect(profile.systemPrompt).toContain("BOUNDARY:");
      expect(profile.systemPrompt).toContain("HANDOFF:");
    }
  });

  it("fills missing prompt profiles without overwriting user edits", () => {
    const first = ensureBuiltinPromptProfiles({});
    expect(first.promptProfiles).toHaveLength(BUILTIN_PROMPT_PROFILES.length);

    const customized = ensureBuiltinPromptProfiles({
      promptProfiles: [{
        id: "kyrei-main",
        name: "Mine",
        description: "custom",
        systemPrompt: "Speak like a pirate.",
      }],
    });
    const main = customized.promptProfiles.find((p) => p.id === "kyrei-main");
    expect(main?.systemPrompt).toBe("Speak like a pirate.");
    expect(customized.promptProfiles.length).toBe(BUILTIN_PROMPT_PROFILES.length);
  });

  it("seeds team only when profiles are empty; leaves mode single", () => {
    const providers = [{
      id: "p",
      enabled: true,
      models: [{ id: "m" }],
    }];
    const seeded = ensureBuiltinTeamOrchestration(
      { defaultMode: "single", activeProfileId: "", profiles: [] },
      providers,
      { providerId: "p", modelId: "m" },
    );
    expect(seeded.defaultMode).toBe("single");
    expect(seeded.profiles).toHaveLength(1);
    expect(seeded.activeProfileId).toBe(BUILTIN_TEAM_PROFILE_ID);

    const untouched = ensureBuiltinTeamOrchestration(
      {
        defaultMode: "single",
        activeProfileId: "mine",
        profiles: [{ id: "mine", name: "Mine", workflow: "supervisor", roles: [], limits: {}, enabled: true }],
      },
      providers,
      { providerId: "p", modelId: "m" },
    );
    expect(untouched.profiles).toHaveLength(1);
    expect(untouched.profiles[0].id).toBe("mine");
  });
});
