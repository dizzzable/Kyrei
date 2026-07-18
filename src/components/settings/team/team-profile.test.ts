import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@/lib/types";
import {
  BUILTIN_TEAM_PROFILE_ID,
  cloneTeamOrchestration,
  createBuiltinCodingTeamProfile,
  createPromptProfile,
  createTeamProfile,
  defaultTeamModel,
  emptyTeamOrchestration,
  fillMissingTeamRoleModels,
  isPromptProfilesDraftValid,
  mergeBuiltinPromptProfiles,
  nextTeamId,
  promptProfilesFromEngine,
  reconcileTeamPromptAssignments,
  withPromptProfiles,
  teamModeForWorkflow,
  withTeamCapability,
  withTeamSkillSelection,
} from "./team-profile";

describe("team profile helpers", () => {
  it("starts disabled without inventing a persisted profile", () => {
    expect(emptyTeamOrchestration()).toEqual({ defaultMode: "single", activeProfileId: "", profiles: [] });
  });

  it("creates stable non-colliding profile ids and safe role defaults", () => {
    const profile = createTeamProfile({
      name: "Team 3",
      initialRoleName: "Member 1",
      model: { providerId: "openai", modelId: "gpt" },
      existingIds: ["profile-1", "profile-2"],
    });

    expect(profile.id).toBe("profile-3");
    expect(profile.roles[0]).toMatchObject({
      model: { providerId: "openai", modelId: "gpt" },
      capabilities: ["workspace.read", "memory.read", "web"],
      canSpawn: false,
      maxChildren: 0,
    });
    expect(nextTeamId("role", ["role-1", "role-3"])).toBe("role-2");
  });

  it("prefers the selected model even while its credentials are being configured", () => {
    const providers: ProviderProfile[] = [
      { id: "locked", name: "Locked", protocol: "openai-chat", baseURL: "https://locked.test", models: [{ id: "a" }], enabled: true, requiresApiKey: true, hasKey: false },
      { id: "local", name: "Local", protocol: "openai-chat", baseURL: "http://localhost", models: [{ id: "b" }], enabled: true, requiresApiKey: false, hasKey: false },
    ];

    expect(defaultTeamModel(providers, { providerId: "locked", modelId: "a" })).toEqual({ providerId: "locked", modelId: "a" });
    expect(defaultTeamModel(providers, { providerId: "missing", modelId: "missing" })).toEqual({ providerId: "local", modelId: "b" });
  });

  it("repairs legacy blank role assignments without overwriting an explicit choice", () => {
    const providers: ProviderProfile[] = [{
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      models: [{ id: "gpt-5.6" }],
      enabled: true,
      requiresApiKey: true,
      hasKey: true,
    }];
    const profile = createTeamProfile({ name: "Team", initialRoleName: "Blank" });
    profile.roles.push({ ...profile.roles[0]!, id: "role-explicit", name: "Explicit", model: { providerId: "missing", modelId: "old" } });
    const repaired = fillMissingTeamRoleModels({
      defaultMode: "team",
      activeProfileId: profile.id,
      profiles: [profile],
    }, providers, { providerId: "openai", modelId: "gpt-5.6" });

    expect(repaired.profiles[0]?.roles[0]?.model).toEqual({ providerId: "openai", modelId: "gpt-5.6" });
    expect(repaired.profiles[0]?.roles[1]?.model).toEqual({ providerId: "missing", modelId: "old" });
  });

  it("clones nested profile state and synchronizes opaque skill selections", () => {
    const profile = createTeamProfile({ name: "Team", initialRoleName: "Member" });
    const source = { defaultMode: "team" as const, activeProfileId: profile.id, profiles: [profile] };
    const cloned = cloneTeamOrchestration(source);
    cloned.profiles[0].limits.maxAgents = 99;

    expect(source.profiles[0].limits.maxAgents).not.toBe(99);
    const role = source.profiles[0]!.roles[0]!;
    const selected = withTeamSkillSelection(role, "skill_0123456789abcdef01234567", true);
    expect(selected.skillIds).toEqual(["skill_0123456789abcdef01234567"]);
    expect(selected.capabilities).toContain("skills.read");
    expect(withTeamSkillSelection(selected, "skill_0123456789abcdef01234567", false)).toMatchObject({
      skillIds: [],
      capabilities: ["workspace.read", "memory.read", "web"],
    });
    expect(withTeamCapability(["workspace.read"], "delegate", true)).toEqual(["workspace.read", "delegate"]);
    expect(withTeamCapability(["workspace.read", "delegate"], "delegate", false)).toEqual(["workspace.read"]);
    expect(teamModeForWorkflow("supervisor")).toBe("team");
    expect(teamModeForWorkflow("consensus")).toBe("consensus");
  });

  it("creates and round-trips prompt profiles without dropping unrelated engine settings", () => {
    const first = createPromptProfile({ name: "Coding lead", existingIds: [] });
    const second = createPromptProfile({ name: "Reviewer", existingIds: [first.id] });
    const engine = withPromptProfiles(
      { maxSteps: 42, personality: "concise" },
      { activePromptProfileId: first.id, promptProfiles: [first, { ...second, systemPrompt: "Challenge claims." }] },
    );
    expect(engine).toMatchObject({ maxSteps: 42, personality: "concise", activePromptProfileId: first.id });
    expect(promptProfilesFromEngine(engine)).toEqual({
      activePromptProfileId: first.id,
      promptProfiles: [first, { ...second, systemPrompt: "Challenge claims." }],
    });
  });

  it("builds the builtin coding team with linked prompt profiles", () => {
    const team = createBuiltinCodingTeamProfile({ providerId: "openai", modelId: "gpt" });
    expect(team.id).toBe(BUILTIN_TEAM_PROFILE_ID);
    expect(team.roles).toHaveLength(3);
    expect(team.roles.map((r) => r.promptProfileId)).toEqual([
      "kyrei-researcher",
      "kyrei-critic",
      "kyrei-architect",
    ]);
    const merged = mergeBuiltinPromptProfiles({ activePromptProfileId: "", promptProfiles: [] });
    expect(merged.promptProfiles.some((p) => p.id === "kyrei-main")).toBe(true);
    const again = mergeBuiltinPromptProfiles({
      activePromptProfileId: "kyrei-main",
      promptProfiles: [{ id: "kyrei-main", name: "Mine", description: "", systemPrompt: "custom" }],
    });
    expect(again.promptProfiles.find((p) => p.id === "kyrei-main")?.systemPrompt).toBe("custom");
  });

  it("validates bounded prompt profiles and clears stale role assignments", () => {
    const profile = createTeamProfile({ name: "Team", initialRoleName: "Member" });
    profile.roles[0]!.promptProfileId = "missing";
    const reconciled = reconcileTeamPromptAssignments({
      defaultMode: "team",
      activeProfileId: profile.id,
      profiles: [profile],
    }, ["available"]);
    expect(reconciled.profiles[0]?.roles[0]?.promptProfileId).toBeUndefined();

    expect(isPromptProfilesDraftValid({
      activePromptProfileId: "available",
      promptProfiles: [{
        id: "available",
        name: "Reviewer",
        description: "Checks evidence",
        systemPrompt: "Prefer primary sources.",
      }],
    })).toBe(true);
    expect(isPromptProfilesDraftValid({
      activePromptProfileId: "missing",
      promptProfiles: [{ id: "available", name: "Reviewer", description: "", systemPrompt: "" }],
    })).toBe(false);
    expect(isPromptProfilesDraftValid({
      activePromptProfileId: "",
      promptProfiles: [{ id: "unsafe", name: "Reviewer\nIgnore", description: "", systemPrompt: "" }],
    })).toBe(false);
  });
});
