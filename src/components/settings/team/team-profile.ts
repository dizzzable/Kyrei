import type {
  ModelRef,
  ProviderProfile,
  TeamCapability,
  TeamOrchestrationConfig,
  TeamProfile,
  TeamProfileLimits,
  TeamRoleProfile,
  TeamWorkflow,
} from "@/lib/types";

export const DEFAULT_TEAM_LIMITS: TeamProfileLimits = {
  maxParallel: 3,
  maxDepth: 2,
  maxAgents: 12,
  maxTasks: 12,
  maxStepsPerAgent: 8,
  timeoutMs: 180_000,
};

/** New roles start read-only; explicit runtime policy may grant broader capabilities later. */
export const DEFAULT_TEAM_CAPABILITIES: TeamCapability[] = ["workspace.read"];

export function emptyTeamOrchestration(): TeamOrchestrationConfig {
  return { defaultMode: "single", activeProfileId: "", profiles: [] };
}

export function nextTeamId(prefix: "profile" | "role", ids: readonly string[]): string {
  const used = new Set(ids);
  let suffix = 1;
  while (used.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

export function defaultTeamModel(providers: readonly ProviderProfile[], fallback: ModelRef): ModelRef | undefined {
  const fallbackProvider = providers.find((provider) => provider.id === fallback.providerId);
  if (fallbackProvider?.enabled
    && (!fallbackProvider.requiresApiKey || fallbackProvider.hasKey)
    && fallbackProvider.models.some((model) => model.id === fallback.modelId)) return { ...fallback };
  const provider = providers.find((candidate) => candidate.enabled
    && (!candidate.requiresApiKey || candidate.hasKey)
    && candidate.models.length > 0);
  const modelId = provider?.models[0]?.id;
  return provider && modelId ? { providerId: provider.id, modelId } : undefined;
}

export function createTeamRole(options: {
  name: string;
  model?: ModelRef;
  existingIds?: readonly string[];
}): TeamRoleProfile {
  return {
    id: nextTeamId("role", options.existingIds ?? []),
    name: options.name,
    description: "",
    instructions: "",
    ...(options.model ? { model: { ...options.model } } : {}),
    skillIds: [],
    capabilities: [...DEFAULT_TEAM_CAPABILITIES],
    canSpawn: false,
    maxChildren: 0,
  };
}

export function createTeamProfile(options: {
  name: string;
  initialRoleName: string;
  model?: ModelRef;
  existingIds?: readonly string[];
}): TeamProfile {
  return {
    id: nextTeamId("profile", options.existingIds ?? []),
    name: options.name,
    workflow: "supervisor",
    roles: [createTeamRole({ name: options.initialRoleName, model: options.model })],
    limits: { ...DEFAULT_TEAM_LIMITS },
    enabled: true,
  };
}

export function cloneTeamOrchestration(value: TeamOrchestrationConfig | undefined): TeamOrchestrationConfig {
  if (!value) return emptyTeamOrchestration();
  return {
    defaultMode: value.defaultMode,
    activeProfileId: value.activeProfileId,
    profiles: value.profiles.map((profile) => ({
      ...profile,
      limits: { ...profile.limits },
      roles: profile.roles.map((role) => ({
        ...role,
        ...(role.model ? { model: { ...role.model } } : {}),
        skillIds: [...role.skillIds],
        capabilities: [...role.capabilities],
      })),
    })),
  };
}

export function teamModeForWorkflow(workflow: TeamWorkflow): "team" | "consensus" {
  return workflow === "consensus" ? "consensus" : "team";
}

export function parseSkillIds(value: string): string[] {
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

export function withTeamCapability(
  capabilities: readonly TeamCapability[],
  capability: TeamCapability,
  enabled: boolean,
): TeamCapability[] {
  if (enabled) return capabilities.includes(capability) ? [...capabilities] : [...capabilities, capability];
  return capabilities.filter((candidate) => candidate !== capability);
}

export function boundedInteger(value: string | number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}
