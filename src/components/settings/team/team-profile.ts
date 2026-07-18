import type {
  ModelRef,
  PromptProfile,
  ProviderProfile,
  TeamCapability,
  TeamOrchestrationConfig,
  TeamProfile,
  TeamProfileLimits,
  TeamRoleProfile,
  TeamWorkflow,
} from "@/lib/types";

export interface PromptProfilesDraft {
  activePromptProfileId: string;
  promptProfiles: PromptProfile[];
}

export const DEFAULT_TEAM_LIMITS: TeamProfileLimits = {
  maxParallel: 3,
  maxDepth: 2,
  maxAgents: 12,
  maxTasks: 12,
  maxStepsPerAgent: 8,
  timeoutMs: 180_000,
  idleTimeoutMs: 180_000,
  maxRuntimeMs: 1_800_000,
};

/**
 * New roles start read-only (no write/shell). Include memory + web so OOB team
 * research works without per-role capability babysitting.
 */
export const DEFAULT_TEAM_CAPABILITIES: TeamCapability[] = [
  "workspace.read",
  "memory.read",
  "web",
];

/** Stable built-in ids (must match core/team-defaults.js). */
export const BUILTIN_PROMPT_PROFILE_IDS = {
  main: "kyrei-main",
  researcher: "kyrei-researcher",
  critic: "kyrei-critic",
  architect: "kyrei-architect",
} as const;

export const BUILTIN_TEAM_PROFILE_ID = "kyrei-coding-team";

/** Starter prompt bodies (English). Users can edit freely in Settings. */
export const BUILTIN_PROMPT_PROFILES: readonly PromptProfile[] = [
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.main,
    name: "Main coding agent",
    description: "Default style for the acting agent: grounded edits, verify, no thrash.",
    systemPrompt: [
      "You are the acting Kyrei coding agent for this workspace.",
      "Prefer tools over guesses. Read before edit. Small verifiable steps.",
      "When research can be parallelized, use delegate_read (or team_delegate when Team is on).",
      "You remain responsible for synthesis, edits, and final answers.",
      "Match the user's language. Be concise; state paths and verification.",
    ].join(" "),
  },
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.researcher,
    name: "Researcher",
    description: "Broad code+web evidence gathering; reports sources and uncertainty.",
    systemPrompt: [
      "Role: researcher / scout.",
      "Map the relevant code and external docs for the assigned goal.",
      "Prefer project tools first (map, grep, read, memory_search), then web when external truth matters.",
      "Treat web snippets as leads until you fetch a primary source.",
      "Return evidence with paths/URLs, confidence, and what you did not check.",
      "Do not implement or claim workspace changes.",
    ].join(" "),
  },
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.critic,
    name: "Critic",
    description: "Adversarial review of claims, risks, and missing checks.",
    systemPrompt: [
      "Role: critic / verifier.",
      "Challenge weak claims, contradictions, and missing tests or edge cases.",
      "Prefer concrete counter-evidence from files or primary sources over opinion.",
      "Flag security, correctness, and migration risks.",
      "Do not implement fixes unless the task explicitly asks for a proposed patch artifact.",
    ].join(" "),
  },
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.architect,
    name: "Architect",
    description: "Design options, tradeoffs, and a decision-complete plan.",
    systemPrompt: [
      "Role: architect / planner.",
      "Propose 1–2 concrete approaches with tradeoffs, modules/files, and acceptance checks.",
      "Eliminate unknowns with tools before asking the human.",
      "Output a decision-complete plan; do not write product code unless asked for a patch artifact.",
    ].join(" "),
  },
] as const;

const PROMPT_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

export function emptyTeamOrchestration(): TeamOrchestrationConfig {
  return { defaultMode: "single", activeProfileId: "", profiles: [] };
}

export function nextTeamId(prefix: "profile" | "role", ids: readonly string[]): string {
  const used = new Set(ids);
  let suffix = 1;
  while (used.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

export function createPromptProfile(options: {
  name: string;
  existingIds?: readonly string[];
}): PromptProfile {
  const used = new Set(options.existingIds ?? []);
  let suffix = 1;
  while (used.has(`prompt-${suffix}`)) suffix += 1;
  return {
    id: `prompt-${suffix}`,
    name: options.name,
    description: "",
    systemPrompt: "",
  };
}

export function promptProfilesFromEngine(engine: Record<string, unknown> | undefined): PromptProfilesDraft {
  const source = engine ?? {};
  const promptProfiles = Array.isArray(source.promptProfiles)
    ? source.promptProfiles.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const profile = value as Record<string, unknown>;
        if (typeof profile.id !== "string" || typeof profile.name !== "string") return [];
        return [{
          id: profile.id,
          name: profile.name,
          description: typeof profile.description === "string" ? profile.description : "",
          systemPrompt: typeof profile.systemPrompt === "string" ? profile.systemPrompt : "",
        }];
      })
    : [];
  const requested = typeof source.activePromptProfileId === "string" ? source.activePromptProfileId : "";
  return {
    promptProfiles,
    activePromptProfileId: promptProfiles.some((profile) => profile.id === requested) ? requested : "",
  };
}

export function withPromptProfiles(
  engine: Record<string, unknown> | undefined,
  draft: PromptProfilesDraft,
): Record<string, unknown> {
  return {
    ...(engine ?? {}),
    activePromptProfileId: draft.activePromptProfileId,
    promptProfiles: draft.promptProfiles.map((profile) => ({ ...profile })),
  };
}

export function isPromptProfilesDraftValid(draft: PromptProfilesDraft): boolean {
  if (draft.promptProfiles.length > 64) return false;
  const ids = new Set<string>();
  for (const profile of draft.promptProfiles) {
    if (!PROMPT_PROFILE_ID.test(profile.id) || ids.has(profile.id)) return false;
    ids.add(profile.id);
    if (!profile.name.trim() || profile.name.trim().length > 120 || SINGLE_LINE_CONTROL.test(profile.name)) return false;
    if (profile.description.trim().length > 1_000 || SINGLE_LINE_CONTROL.test(profile.description)) return false;
    if (profile.systemPrompt.trim().length > 20_000 || MULTILINE_CONTROL.test(profile.systemPrompt)) return false;
  }
  return !draft.activePromptProfileId || ids.has(draft.activePromptProfileId);
}

export function reconcileTeamPromptAssignments(
  value: TeamOrchestrationConfig | undefined,
  availableProfileIds: readonly string[],
): TeamOrchestrationConfig {
  const result = cloneTeamOrchestration(value);
  const available = new Set(availableProfileIds);
  result.profiles = result.profiles.map((profile) => ({
    ...profile,
    roles: profile.roles.map((role) => {
      if (!role.promptProfileId || available.has(role.promptProfileId)) return role;
      const clean = { ...role };
      delete clean.promptProfileId;
      return clean;
    }),
  }));
  return result;
}

export function defaultTeamModel(providers: readonly ProviderProfile[], fallback: ModelRef): ModelRef | undefined {
  const fallbackProvider = providers.find((provider) => provider.id === fallback.providerId);
  if (fallbackProvider?.enabled
    && fallbackProvider.models.some((model) => model.id === fallback.modelId)) return { ...fallback };
  const provider = providers.find((candidate) => candidate.enabled
    && (!candidate.requiresApiKey || candidate.hasKey)
    && candidate.models.length > 0);
  const modelId = provider?.models[0]?.id;
  return provider && modelId ? { providerId: provider.id, modelId } : undefined;
}

/**
 * A team role needs an explicit model, but profiles can outlive a provider
 * refresh. Fill only missing assignments from the currently selected model;
 * never rewrite a deliberate per-role choice (even an invalid one), so the
 * user can see and correct it in the UI.
 */
export function fillMissingTeamRoleModels(
  value: TeamOrchestrationConfig | undefined,
  providers: readonly ProviderProfile[],
  fallback: ModelRef,
): TeamOrchestrationConfig {
  const result = cloneTeamOrchestration(value);
  const model = defaultTeamModel(providers, fallback);
  if (!model) return result;

  result.profiles = result.profiles.map((profile) => ({
    ...profile,
    roles: profile.roles.map((role) => (
      role.model?.providerId && role.model.modelId
        ? role
        : { ...role, model: { ...model } }
    )),
  }));
  return result;
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

/**
 * Ready-to-use coding team (researcher + critic + architect).
 * Used when enabling Team with no profiles yet.
 */
export function createBuiltinCodingTeamProfile(model?: ModelRef): TeamProfile {
  const role = (id: string, name: string, description: string, instructions: string, promptProfileId: string): TeamRoleProfile => ({
    id,
    name,
    description,
    instructions,
    ...(model ? { model: { ...model } } : {}),
    skillIds: [],
    capabilities: [...DEFAULT_TEAM_CAPABILITIES],
    canSpawn: false,
    maxChildren: 0,
    promptProfileId,
  });
  return {
    id: BUILTIN_TEAM_PROFILE_ID,
    name: "Coding team",
    workflow: "supervisor",
    limits: { ...DEFAULT_TEAM_LIMITS },
    enabled: true,
    roles: [
      role(
        "researcher",
        "Researcher",
        "Code and web research; returns source-backed findings.",
        "Investigate independently. Prefer local project evidence, then web. Cite paths/URLs. List uncertainties.",
        BUILTIN_PROMPT_PROFILE_IDS.researcher,
      ),
      role(
        "critic",
        "Critic",
        "Reviews claims, risks, and gaps before the acting agent commits.",
        "Stress-test conclusions and proposed plans. Demand evidence. Call out missing tests and failure modes.",
        BUILTIN_PROMPT_PROFILE_IDS.critic,
      ),
      role(
        "architect",
        "Architect",
        "Structures options into a decision-complete plan.",
        "Turn research into a clear plan: approach, files, risks, acceptance criteria, ordered steps.",
        BUILTIN_PROMPT_PROFILE_IDS.architect,
      ),
    ],
  };
}

/** Merge missing built-in prompt profiles; never overwrite existing ids. */
export function mergeBuiltinPromptProfiles(draft: PromptProfilesDraft): PromptProfilesDraft {
  const ids = new Set(draft.promptProfiles.map((p) => p.id));
  const extras = BUILTIN_PROMPT_PROFILES.filter((p) => !ids.has(p.id)).map((p) => ({ ...p }));
  if (!extras.length) return draft;
  return {
    ...draft,
    promptProfiles: [...draft.promptProfiles, ...extras],
  };
}

export function cloneTeamOrchestration(value: TeamOrchestrationConfig | undefined): TeamOrchestrationConfig {
  if (!value) return emptyTeamOrchestration();
  return {
    defaultMode: value.defaultMode,
    activeProfileId: value.activeProfileId,
    profiles: value.profiles.map((profile) => ({
      ...profile,
      limits: { ...DEFAULT_TEAM_LIMITS, ...profile.limits },
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

export function withTeamCapability(
  capabilities: readonly TeamCapability[],
  capability: TeamCapability,
  enabled: boolean,
): TeamCapability[] {
  if (enabled) return capabilities.includes(capability) ? [...capabilities] : [...capabilities, capability];
  return capabilities.filter((candidate) => candidate !== capability);
}

export function withTeamSkillSelection(
  role: TeamRoleProfile,
  skillId: string,
  selected: boolean,
): TeamRoleProfile {
  const skillIds = selected
    ? [...new Set([...role.skillIds, skillId])]
    : role.skillIds.filter((candidate) => candidate !== skillId);
  return {
    ...role,
    skillIds,
    capabilities: withTeamCapability(role.capabilities, "skills.read", skillIds.length > 0),
  };
}

export function boundedInteger(value: string | number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}
