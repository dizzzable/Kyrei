import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@/lib/types";
import {
  cloneTeamOrchestration,
  createTeamProfile,
  defaultTeamModel,
  emptyTeamOrchestration,
  nextTeamId,
  parseSkillIds,
  teamModeForWorkflow,
  withTeamCapability,
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
      capabilities: ["workspace.read"],
      canSpawn: false,
      maxChildren: 0,
    });
    expect(nextTeamId("role", ["role-1", "role-3"])).toBe("role-2");
  });

  it("prefers the current model and otherwise falls back to a ready provider", () => {
    const providers: ProviderProfile[] = [
      { id: "locked", name: "Locked", protocol: "openai-chat", baseURL: "https://locked.test", models: [{ id: "a" }], enabled: true, requiresApiKey: true, hasKey: false },
      { id: "local", name: "Local", protocol: "openai-chat", baseURL: "http://localhost", models: [{ id: "b" }], enabled: true, requiresApiKey: false, hasKey: false },
    ];

    expect(defaultTeamModel(providers, { providerId: "locked", modelId: "a" })).toEqual({ providerId: "local", modelId: "b" });
    expect(defaultTeamModel(providers, { providerId: "missing", modelId: "missing" })).toEqual({ providerId: "local", modelId: "b" });
  });

  it("clones nested profile state and normalizes skill text", () => {
    const profile = createTeamProfile({ name: "Team", initialRoleName: "Member" });
    const source = { defaultMode: "team" as const, activeProfileId: profile.id, profiles: [profile] };
    const cloned = cloneTeamOrchestration(source);
    cloned.profiles[0].limits.maxAgents = 99;

    expect(source.profiles[0].limits.maxAgents).not.toBe(99);
    expect(parseSkillIds(" testing, code-review, testing,  ")).toEqual(["testing", "code-review"]);
    expect(withTeamCapability(["workspace.read"], "delegate", true)).toEqual(["workspace.read", "delegate"]);
    expect(withTeamCapability(["workspace.read", "delegate"], "delegate", false)).toEqual(["workspace.read"]);
    expect(teamModeForWorkflow("supervisor")).toBe("team");
    expect(teamModeForWorkflow("consensus")).toBe("consensus");
  });
});
