import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEAM_LIMITS,
  MAX_TEAM_PROFILE_SKILLS,
  MAX_TEAM_PROFILES,
  MAX_TEAM_ROLES,
  TEAM_CAPABILITIES,
  normalizeOrchestration,
  validateOrchestrationInput,
} from "../core/team-config.js";
import {
  normalizeGatewayConfig,
  normalizeProviderSecrets,
  publicGatewayConfig,
  removeProvider,
} from "../core/provider-config.js";

const providers = [
  {
    id: "lead",
    name: "Lead",
    protocol: "openai-chat",
    baseURL: "https://lead.example/v1",
    models: [{ id: "lead-model" }],
    enabled: true,
    requiresApiKey: true,
  },
  {
    id: "worker",
    name: "Worker",
    protocol: "openai-chat",
    baseURL: "https://worker.example/v1",
    models: [{ id: "worker-model" }],
    enabled: true,
    requiresApiKey: true,
  },
];

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "research-team",
    name: "Research team",
    workflow: "supervisor",
    roles: [
      {
        id: "researcher",
        name: "Researcher",
        description: "Find grounded evidence",
        instructions: "Check primary sources.",
        promptProfileId: "research-policy",
        model: { providerId: "worker", modelId: "worker-model" },
        skillIds: ["repo-research"],
        capabilities: ["workspace.read", "web", "skills.read"],
        canSpawn: true,
        maxChildren: 2,
      },
    ],
    limits: DEFAULT_TEAM_LIMITS,
    ...overrides,
  };
}

describe("team orchestration config", () => {
  it("migrates every missing or legacy orchestration config to single mode", () => {
    expect(normalizeOrchestration(undefined, providers)).toEqual({
      defaultMode: "single",
      activeProfileId: "",
      profiles: [],
    });
    // OOB seed: coding team is present; mode remains single until the user enables Team.
    expect(normalizeGatewayConfig({ provider: "https://legacy.example/v1", model: "legacy" }).orchestration)
      .toMatchObject({
        defaultMode: "single",
        activeProfileId: "kyrei-coding-team",
        profiles: [expect.objectContaining({
          id: "kyrei-coding-team",
          workflow: "supervisor",
          roles: expect.arrayContaining([
            expect.objectContaining({ id: "researcher" }),
            expect.objectContaining({ id: "critic" }),
            expect.objectContaining({ id: "architect" }),
          ]),
        })],
      });
  });

  it("normalizes arbitrary roles, bounded capabilities, and safe limits", () => {
    const config = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: "research-team",
      profiles: [profile({
        limits: {
          maxParallel: 99,
          maxDepth: -2,
          maxAgents: 999,
          maxTasks: 0,
          maxStepsPerAgent: 999,
          timeoutMs: 99_000_000,
        },
        roles: [
          {
            id: "custom-role",
            name: "Custom role",
            description: "Arbitrary user role",
            instructions: "Investigate only.",
            promptProfileId: "research-policy",
            model: { providerId: "worker", modelId: "worker-model" },
            skillIds: ["skill-a", "skill-a", "skill-b"],
            capabilities: ["workspace.read", "web", "terminal", "web", "delegate"],
            canSpawn: true,
            maxChildren: 500,
          },
        ],
      })],
    }, providers);

    expect(config.defaultMode).toBe("team");
    expect(config.profiles[0]).toMatchObject({
      id: "research-team",
      enabled: true,
      limits: {
        maxParallel: 1,
        maxDepth: 0,
        maxAgents: 64,
        maxTasks: 1,
        maxStepsPerAgent: 64,
        timeoutMs: 3_600_000,
      },
    });
    expect(config.profiles[0]?.roles[0]).toMatchObject({
      id: "custom-role",
      promptProfileId: "research-policy",
      skillIds: ["skill-a", "skill-b"],
      capabilities: ["workspace.read", "web", "delegate", "skills.read"],
      canSpawn: true,
      maxChildren: 12,
      model: { providerId: "worker", modelId: "worker-model" },
    });
    expect(TEAM_CAPABILITIES).not.toContain("terminal");
  });

  it("requires an explicit delegate capability before a role may spawn helpers", () => {
    const config = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: "research-team",
      profiles: [profile()],
    }, providers);

    expect(config.profiles[0]?.roles[0]).toMatchObject({ canSpawn: false, maxChildren: 0 });

    const delegated = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: "research-team",
      profiles: [profile({
        roles: [{
          ...profile().roles[0],
          capabilities: ["workspace.read", "delegate"],
          canSpawn: true,
          maxChildren: 2,
        }],
      })],
    }, providers);
    expect(delegated.profiles[0]?.roles[0]).toMatchObject({ canSpawn: true, maxChildren: 2 });
  });

  it("disables profiles with dangling model refs and never activates them", () => {
    const config = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: "broken",
      profiles: [profile({
        id: "broken",
        roles: [{
          ...profile().roles[0],
          model: { providerId: "missing", modelId: "missing-model" },
        }],
      })],
    }, providers);

    expect(config).toMatchObject({ defaultMode: "single", activeProfileId: "broken" });
    expect(config.profiles[0]).toMatchObject({
      id: "broken",
      enabled: false,
      disabledReason: "model_reference_unavailable",
    });
    expect(config.profiles[0]?.roles[0]?.model).toBeUndefined();
  });

  it("keeps explicit profile disablement and validates the selected workflow", () => {
    const disabled = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: "research-team",
      profiles: [profile({ enabled: false })],
    }, providers);
    expect(disabled).toMatchObject({ defaultMode: "single", activeProfileId: "research-team" });
    expect(disabled.profiles[0]).toMatchObject({ enabled: false, disabledReason: "profile_disabled" });

    const mismatch = normalizeOrchestration({
      defaultMode: "consensus",
      activeProfileId: "research-team",
      profiles: [profile()],
    }, providers);
    expect(mismatch).toMatchObject({ defaultMode: "single", activeProfileId: "research-team" });

    const consensus = normalizeOrchestration({
      defaultMode: "consensus",
      activeProfileId: "panel",
      profiles: [profile({ id: "panel", workflow: "consensus" })],
    }, providers);
    expect(consensus).toMatchObject({ defaultMode: "consensus", activeProfileId: "panel" });
  });

  it("strips unknown fields and values that could carry credentials", () => {
    const normalized = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: "research-team",
      apiKey: "orchestration-secret",
      profiles: [profile({
        secret: "profile-secret",
        roles: [{
          ...profile().roles[0],
          apiKey: "role-secret",
          model: {
            providerId: "worker",
            modelId: "worker-model",
            headers: { Authorization: "model-secret" },
          },
        }],
      })],
    }, providers);

    expect(JSON.stringify(normalized)).not.toMatch(/orchestration-secret|profile-secret|role-secret|model-secret|Authorization/);
  });

  it("applies defensive collection caps while preserving a large user-defined roster", () => {
    const manyProfiles = Array.from({ length: MAX_TEAM_PROFILES + 20 }, (_, profileIndex) => profile({
      id: `profile-${profileIndex}`,
      roles: Array.from({ length: MAX_TEAM_ROLES + 20 }, (_, roleIndex) => ({
        id: `role-${roleIndex}`,
        name: `Role ${roleIndex}`,
        skillIds: [],
        capabilities: ["workspace.read"],
        canSpawn: false,
        maxChildren: 0,
      })),
    }));
    const normalized = normalizeOrchestration({ profiles: manyProfiles }, providers);
    expect(normalized.profiles).toHaveLength(MAX_TEAM_PROFILES);
    expect(normalized.profiles[0]?.roles).toHaveLength(MAX_TEAM_ROLES);
  });

  it("keeps a profile's distinct selected skills within the executable runtime capacity", () => {
    const selectedSkillIds = Array.from(
      { length: MAX_TEAM_PROFILE_SKILLS + 1 },
      (_unused, index) => `selected-skill-${index + 1}`,
    );
    const roles = Array.from({ length: 3 }, (_unused, index) => {
      const offset = index * 128;
      return {
        ...profile().roles[0],
        id: `skill-role-${index + 1}`,
        name: `Skill role ${index + 1}`,
        skillIds: selectedSkillIds.slice(offset, offset + 128),
        capabilities: ["workspace.read"],
        canSpawn: false,
        maxChildren: 0,
      };
    });
    const overCapacity = profile({ roles });

    const migrated = normalizeOrchestration({
      defaultMode: "team",
      activeProfileId: overCapacity.id,
      profiles: [overCapacity],
    }, providers);
    expect(migrated).toMatchObject({ defaultMode: "single", activeProfileId: overCapacity.id });
    expect(migrated.profiles[0]).toMatchObject({
      enabled: false,
      disabledReason: "profile_skills_limit_exceeded",
    });

    expect(() => validateOrchestrationInput({
      defaultMode: "team",
      activeProfileId: overCapacity.id,
      profiles: [overCapacity],
    }, providers)).toThrow("team_profile_skills_limit_exceeded");

    const atCapacity = profile({
      roles: roles.slice(0, 2),
    });
    expect(validateOrchestrationInput({
      defaultMode: "team",
      activeProfileId: atCapacity.id,
      profiles: [atCapacity],
    }, providers)).toMatchObject({ defaultMode: "team" });
  });

  it("strictly validates route input with stable non-localized error codes", () => {
    const valid = validateOrchestrationInput({
      defaultMode: "team",
      activeProfileId: "research-team",
      profiles: [profile({
        roles: [{
          ...profile().roles[0],
          capabilities: ["workspace.read", "delegate"],
        }],
      })],
    }, providers);
    expect(valid.defaultMode).toBe("team");

    expect(() => validateOrchestrationInput({ defaultMode: "swarm", profiles: [] }, providers))
      .toThrow("orchestration_mode_invalid");
    expect(() => validateOrchestrationInput({
      defaultMode: "single",
      profiles: [profile({ roles: [{ ...profile().roles[0], capabilities: ["terminal"] }] })],
    }, providers)).toThrow("team_role_capability_invalid");
    expect(() => validateOrchestrationInput({
      defaultMode: "single",
      profiles: [profile({
        limits: { ...DEFAULT_TEAM_LIMITS, maxDepth: 3 },
        roles: [{ ...profile().roles[0], capabilities: ["workspace.read", "delegate"] }],
      })],
    }, providers)).toThrow("team_limit_maxDepth_invalid");
    expect(() => validateOrchestrationInput({
      defaultMode: "single",
      profiles: [profile({ roles: [{
        ...profile().roles[0],
        model: { providerId: "missing", modelId: "x" },
        canSpawn: false,
        maxChildren: 0,
      }] })],
    }, providers)).toThrow("team_role_model_unavailable");
  });

  it("keeps active consensus rosters within the fan-out task and agent budgets", () => {
    const roles = Array.from({ length: DEFAULT_TEAM_LIMITS.maxAgents + 1 }, (_, index) => ({
      id: `reviewer-${index + 1}`,
      name: `Reviewer ${index + 1}`,
      model: { providerId: "worker", modelId: "worker-model" },
      skillIds: [],
      capabilities: ["workspace.read"],
      canSpawn: false,
      maxChildren: 0,
    }));

    expect(() => validateOrchestrationInput({
      defaultMode: "consensus",
      activeProfileId: "panel",
      profiles: [profile({ id: "panel", workflow: "consensus", roles })],
    }, providers)).toThrow("team_consensus_role_budget_exceeded");

    const supervisor = validateOrchestrationInput({
      defaultMode: "team",
      activeProfileId: "supervisor-team",
      profiles: [profile({ id: "supervisor-team", workflow: "supervisor", roles })],
    }, providers);
    expect(supervisor).toMatchObject({
      defaultMode: "team",
      activeProfileId: "supervisor-team",
    });
    expect(supervisor.profiles[0]?.roles).toHaveLength(DEFAULT_TEAM_LIMITS.maxAgents + 1);
  });

  it("preserves multiline role instructions while rejecting other controls", () => {
    const multiline = "Inspect architecture.\r\nCheck security boundaries.\nReport evidence.";
    const valid = validateOrchestrationInput({
      defaultMode: "team",
      activeProfileId: "research-team",
      profiles: [profile({
        roles: [{
          ...profile().roles[0],
          instructions: multiline,
          capabilities: ["workspace.read", "delegate"],
        }],
      })],
    }, providers);
    expect(valid.profiles[0]?.roles[0]?.instructions).toBe(multiline);

    expect(() => validateOrchestrationInput({
      defaultMode: "single",
      profiles: [profile({
        roles: [{
          ...profile().roles[0],
          instructions: "Inspect\tthen report",
          capabilities: ["workspace.read", "delegate"],
        }],
      })],
    }, providers)).toThrow("team_role_instructions_invalid");

    expect(() => validateOrchestrationInput({
      defaultMode: "single",
      profiles: [profile({ name: "Line one\nLine two" })],
    }, providers)).toThrow("team_profile_name_invalid");
  });

  it("preserves a safe prompt-profile assignment and rejects malformed ids", () => {
    const valid = validateOrchestrationInput({
      defaultMode: "single",
      activeProfileId: "research-team",
      profiles: [profile({
        roles: [{
          ...profile().roles[0],
          capabilities: ["workspace.read", "web", "skills.read", "delegate"],
        }],
      })],
    }, providers);
    expect(valid.profiles[0]?.roles[0]?.promptProfileId).toBe("research-policy");

    expect(() => validateOrchestrationInput({
      defaultMode: "single",
      profiles: [profile({
        roles: [{ ...profile().roles[0], promptProfileId: "../escape" }],
      })],
    }, providers)).toThrow("team_role_prompt_profile_invalid");
  });

  it("can fail closed against the prompt profiles and skills available at the save boundary", () => {
    const requested = {
      defaultMode: "single",
      profiles: [profile({
        roles: [{
          ...profile().roles[0],
          promptProfileId: "research-policy",
          skillIds: ["skill_available"],
          capabilities: ["workspace.read", "web", "skills.read", "delegate"],
        }],
      })],
    };
    expect(() => validateOrchestrationInput(requested, providers, {
      promptProfileIds: new Set(["research-policy"]),
      skillIds: new Set(["skill_available"]),
    })).not.toThrow();
    expect(() => validateOrchestrationInput(requested, providers, {
      promptProfileIds: new Set(),
      skillIds: new Set(["skill_available"]),
    })).toThrow("team_role_prompt_profile_unavailable");
    expect(() => validateOrchestrationInput(requested, providers, {
      promptProfileIds: new Set(["research-policy"]),
      skillIds: new Set(),
    })).toThrow("team_role_skill_unavailable");
  });

  it("reconciles removed providers and returns only safe orchestration publicly", () => {
    let config = normalizeGatewayConfig({
      providers,
      activeProviderId: "lead",
      activeModelId: "lead-model",
      orchestration: {
        defaultMode: "team",
        activeProfileId: "research-team",
        profiles: [profile()],
      },
    });
    expect(config.orchestration.defaultMode).toBe("team");

    config = removeProvider(config, "worker");
    expect(config.orchestration).toMatchObject({ defaultMode: "single", activeProfileId: "research-team" });
    expect(config.orchestration.profiles[0]).toMatchObject({ enabled: false, disabledReason: "model_reference_unavailable" });

    const publicConfig = publicGatewayConfig(config, normalizeProviderSecrets({
      providers: { lead: { apiKey: "private-provider-key" } },
    }));
    expect(publicConfig.orchestration).toEqual(config.orchestration);
    expect(JSON.stringify(publicConfig.orchestration)).not.toContain("private-provider-key");
  });
});
