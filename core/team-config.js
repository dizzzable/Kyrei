/**
 * Public, credential-free configuration for Kyrei Team orchestration.
 *
 * The gateway owns provider credentials. Team profiles may reference only a
 * configured provider/model pair and are reconciled whenever the provider
 * registry changes. Unknown fields are intentionally discarded.
 */

export const TEAM_MODES = ["single", "team", "consensus"];
export const TEAM_WORKFLOWS = ["supervisor", "consensus"];
export const TEAM_CAPABILITIES = [
  "workspace.read",
  "web",
  "memory.read",
  "skills.read",
  "delegate",
];

export const DEFAULT_TEAM_LIMITS = Object.freeze({
  maxParallel: 3,
  maxDepth: 2,
  maxAgents: 12,
  maxTasks: 12,
  maxStepsPerAgent: 8,
  timeoutMs: 180_000,
});

export const MAX_TEAM_PROFILES = 256;
export const MAX_TEAM_ROLES = 128;

const MAX_SKILLS_PER_ROLE = 128;
const MAX_ROLE_CHILDREN = 12;
const MAX_PROFILE_NAME = 160;
const MAX_ROLE_NAME = 160;
const MAX_ROLE_DESCRIPTION = 2_000;
const MAX_ROLE_INSTRUCTIONS = 20_000;
const MAX_SKILL_ID = 200;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;
const CAPABILITY_SET = new Set(TEAM_CAPABILITIES);
const LIMIT_RULES = Object.freeze({
  maxParallel: { min: 1, max: 16, fallback: DEFAULT_TEAM_LIMITS.maxParallel },
  // Team Light supports the role plus one read-only helper generation.
  maxDepth: { min: 0, max: 2, fallback: DEFAULT_TEAM_LIMITS.maxDepth },
  maxAgents: { min: 1, max: 64, fallback: DEFAULT_TEAM_LIMITS.maxAgents },
  maxTasks: { min: 1, max: 64, fallback: DEFAULT_TEAM_LIMITS.maxTasks },
  maxStepsPerAgent: { min: 1, max: 64, fallback: DEFAULT_TEAM_LIMITS.maxStepsPerAgent },
  timeoutMs: { min: 1_000, max: 3_600_000, fallback: DEFAULT_TEAM_LIMITS.timeoutMs },
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, maxLength, fallback = "", { allowLineBreaks = false } = {}) {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  const disallowedControls = allowLineBreaks
    ? CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS
    : CONTROL_CHARACTERS;
  if (!candidate || disallowedControls.test(candidate)) return fallback;
  return candidate.slice(0, maxLength);
}

function normalizeId(value, fallback) {
  const candidate = cleanText(value, 256)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return ID_PATTERN.test(candidate) ? candidate : fallback;
}

function uniqueId(value, fallback, ids) {
  const base = normalizeId(value, fallback);
  let id = base;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${base.slice(0, Math.max(1, 64 - String(suffix).length - 1))}-${suffix}`;
    suffix += 1;
  }
  ids.add(id);
  return id;
}

function integer(value, rule) {
  const candidate = Number.isFinite(value) ? Math.trunc(value) : rule.fallback;
  return Math.min(rule.max, Math.max(rule.min, candidate));
}

function normalizeLimits(value) {
  const source = object(value);
  const limits = {};
  for (const [key, rule] of Object.entries(LIMIT_RULES)) {
    limits[key] = integer(source[key], rule);
  }
  limits.maxParallel = Math.min(limits.maxParallel, limits.maxAgents, limits.maxTasks);
  return limits;
}

function normalizeStringList(value, maxItems, maxLength) {
  const seen = new Set();
  const result = [];
  for (const raw of (Array.isArray(value) ? value : []).slice(0, maxItems)) {
    const candidate = cleanText(raw, maxLength);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function providerModel(value, providers) {
  const source = object(value);
  const providerId = cleanText(source.providerId, 64);
  const modelId = cleanText(source.modelId, 512);
  if (!providerId || !modelId) return null;
  const provider = providers.find((item) => item?.id === providerId && item.enabled !== false);
  if (!provider || !Array.isArray(provider.models) || !provider.models.some((model) => model?.id === modelId)) {
    return null;
  }
  return { providerId, modelId };
}

function normalizeRole(value, index, ids, providers) {
  const source = object(value);
  const id = uniqueId(source.id, `role-${index + 1}`, ids);
  const capabilities = normalizeStringList(source.capabilities, TEAM_CAPABILITIES.length, 64)
    .filter((capability) => CAPABILITY_SET.has(capability));
  if (!capabilities.length) capabilities.push("workspace.read");
  const requestedModel = source.model !== undefined && source.model !== null;
  const model = requestedModel ? providerModel(source.model, providers) : null;
  const spawnRequested = source.canSpawn === true;
  const canSpawn = spawnRequested && capabilities.includes("delegate");
  const maxChildren = canSpawn
    ? integer(source.maxChildren, { min: 1, max: MAX_ROLE_CHILDREN, fallback: 1 })
    : 0;
  return {
    role: {
      id,
      name: cleanText(source.name, MAX_ROLE_NAME, id),
      description: cleanText(source.description, MAX_ROLE_DESCRIPTION),
      instructions: cleanText(source.instructions, MAX_ROLE_INSTRUCTIONS, "", { allowLineBreaks: true }),
      ...(model ? { model } : {}),
      skillIds: normalizeStringList(source.skillIds, MAX_SKILLS_PER_ROLE, MAX_SKILL_ID),
      capabilities,
      canSpawn,
      maxChildren,
    },
    invalidModel: requestedModel && !model,
  };
}

function normalizeProfile(value, index, ids, providers) {
  const source = object(value);
  const id = uniqueId(source.id, `profile-${index + 1}`, ids);
  const roleIds = new Set();
  const roles = [];
  let invalidModel = false;
  for (const [roleIndex, rawRole] of (Array.isArray(source.roles) ? source.roles : [])
    .slice(0, MAX_TEAM_ROLES)
    .entries()) {
    const normalized = normalizeRole(rawRole, roleIndex, roleIds, providers);
    roles.push(normalized.role);
    invalidModel ||= normalized.invalidModel;
  }
  const explicitlyDisabled = source.enabled === false;
  const previousDisabledReason = [
    "profile_disabled",
    "model_reference_unavailable",
    "profile_roles_required",
  ].includes(source.disabledReason)
    ? source.disabledReason
    : "";
  const disabledReason = invalidModel
      ? "model_reference_unavailable"
    : explicitlyDisabled
      ? previousDisabledReason || "profile_disabled"
      : roles.length === 0
        ? "profile_roles_required"
        : "";
  return {
    id,
    name: cleanText(source.name, MAX_PROFILE_NAME, id),
    workflow: TEAM_WORKFLOWS.includes(source.workflow) ? source.workflow : "supervisor",
    roles,
    limits: normalizeLimits(source.limits),
    enabled: !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
  };
}

/**
 * Tolerant migration and reconciliation used for persisted gateway config.
 * Missing configuration is always Single mode; Team never activates by
 * inference. Invalid model references are removed and disable their profile.
 */
export function normalizeOrchestration(value, providers = []) {
  const source = object(value);
  const profileIds = new Set();
  const profiles = [];
  for (const [index, rawProfile] of (Array.isArray(source.profiles) ? source.profiles : [])
    .slice(0, MAX_TEAM_PROFILES)
    .entries()) {
    profiles.push(normalizeProfile(rawProfile, index, profileIds, Array.isArray(providers) ? providers : []));
  }

  const requestedMode = TEAM_MODES.includes(source.defaultMode) ? source.defaultMode : "single";
  const requestedProfileId = cleanText(source.activeProfileId, 64);
  const selectedProfile = profiles.find((profile) => profile.id === requestedProfileId);
  const activeProfile = selectedProfile?.enabled ? selectedProfile : undefined;
  const workflowMatches = requestedMode === "team"
    ? activeProfile?.workflow === "supervisor"
    : requestedMode === "consensus"
      ? activeProfile?.workflow === "consensus"
      : false;
  const defaultMode = requestedMode !== "single" && workflowMatches ? requestedMode : "single";

  return {
    defaultMode,
    activeProfileId: selectedProfile?.id ?? "",
    profiles,
  };
}

export class TeamConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "TeamConfigError";
    this.code = code;
  }
}

function requireObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TeamConfigError(code);
  return value;
}

function requireId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) throw new TeamConfigError(code);
  return value.trim();
}

function validateOptionalText(value, maxLength, code, { required = false, allowLineBreaks = false } = {}) {
  if (value === undefined && !required) return;
  const disallowedControls = allowLineBreaks
    ? CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS
    : CONTROL_CHARACTERS;
  if (
    typeof value !== "string" ||
    (required && !value.trim()) ||
    value.trim().length > maxLength ||
    disallowedControls.test(value)
  ) throw new TeamConfigError(code);
}

function validateLimits(value) {
  if (value === undefined) return;
  const source = requireObject(value, "team_limits_invalid");
  for (const [key, rule] of Object.entries(LIMIT_RULES)) {
    if (source[key] === undefined) continue;
    if (!Number.isInteger(source[key]) || source[key] < rule.min || source[key] > rule.max) {
      throw new TeamConfigError(`team_limit_${key}_invalid`);
    }
  }
  const normalized = normalizeLimits(source);
  if (source.maxParallel !== undefined && normalized.maxParallel !== source.maxParallel) {
    throw new TeamConfigError("team_limit_maxParallel_invalid");
  }
}

function validateRole(value, providers) {
  const source = requireObject(value, "team_role_invalid");
  requireId(source.id, "team_role_id_invalid");
  validateOptionalText(source.name, MAX_ROLE_NAME, "team_role_name_invalid", { required: true });
  validateOptionalText(source.description, MAX_ROLE_DESCRIPTION, "team_role_description_invalid");
  validateOptionalText(source.instructions, MAX_ROLE_INSTRUCTIONS, "team_role_instructions_invalid", { allowLineBreaks: true });

  if (source.skillIds !== undefined) {
    if (!Array.isArray(source.skillIds) || source.skillIds.length > MAX_SKILLS_PER_ROLE) {
      throw new TeamConfigError("team_role_skills_invalid");
    }
    for (const skillId of source.skillIds) {
      validateOptionalText(skillId, MAX_SKILL_ID, "team_role_skill_invalid", { required: true });
    }
  }

  if (source.capabilities !== undefined) {
    if (!Array.isArray(source.capabilities) || source.capabilities.length > TEAM_CAPABILITIES.length) {
      throw new TeamConfigError("team_role_capability_invalid");
    }
    for (const capability of source.capabilities) {
      if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
        throw new TeamConfigError("team_role_capability_invalid");
      }
    }
  }

  if (source.canSpawn !== undefined && typeof source.canSpawn !== "boolean") {
    throw new TeamConfigError("team_role_spawn_invalid");
  }
  if (source.maxChildren !== undefined && (
    !Number.isInteger(source.maxChildren) || source.maxChildren < 0 || source.maxChildren > MAX_ROLE_CHILDREN
  )) throw new TeamConfigError("team_role_spawn_invalid");
  if (source.canSpawn === true && (
    !Array.isArray(source.capabilities) ||
    !source.capabilities.includes("delegate") ||
    !Number.isInteger(source.maxChildren) ||
    source.maxChildren < 1
  )) throw new TeamConfigError("team_role_spawn_invalid");
  if (source.canSpawn !== true && Number(source.maxChildren ?? 0) !== 0) {
    throw new TeamConfigError("team_role_spawn_invalid");
  }

  if (source.model !== undefined && source.model !== null) {
    const modelSource = requireObject(source.model, "team_role_model_invalid");
    if (typeof modelSource.providerId !== "string" || typeof modelSource.modelId !== "string") {
      throw new TeamConfigError("team_role_model_invalid");
    }
    if (!providerModel(modelSource, providers)) throw new TeamConfigError("team_role_model_unavailable");
  }
}

/** Strict validation for an atomic settings PUT boundary. */
export function validateOrchestrationInput(value, providers = []) {
  const source = requireObject(value, "orchestration_invalid");
  if (!TEAM_MODES.includes(source.defaultMode)) throw new TeamConfigError("orchestration_mode_invalid");
  if (source.activeProfileId !== undefined && typeof source.activeProfileId !== "string") {
    throw new TeamConfigError("orchestration_active_profile_invalid");
  }
  if (!Array.isArray(source.profiles) || source.profiles.length > MAX_TEAM_PROFILES) {
    throw new TeamConfigError("team_profiles_invalid");
  }

  const profileIds = new Set();
  for (const rawProfile of source.profiles) {
    const profileSource = requireObject(rawProfile, "team_profile_invalid");
    const profileId = requireId(profileSource.id, "team_profile_id_invalid");
    if (profileIds.has(profileId)) throw new TeamConfigError("team_profile_id_duplicate");
    profileIds.add(profileId);
    validateOptionalText(profileSource.name, MAX_PROFILE_NAME, "team_profile_name_invalid", { required: true });
    if (!TEAM_WORKFLOWS.includes(profileSource.workflow)) throw new TeamConfigError("team_profile_workflow_invalid");
    if (profileSource.enabled !== undefined && typeof profileSource.enabled !== "boolean") {
      throw new TeamConfigError("team_profile_enabled_invalid");
    }
    if (!Array.isArray(profileSource.roles) || profileSource.roles.length === 0 || profileSource.roles.length > MAX_TEAM_ROLES) {
      throw new TeamConfigError("team_profile_roles_invalid");
    }
    const roleIds = new Set();
    for (const rawRole of profileSource.roles) {
      validateRole(rawRole, Array.isArray(providers) ? providers : []);
      const roleId = rawRole.id.trim();
      if (roleIds.has(roleId)) throw new TeamConfigError("team_role_id_duplicate");
      roleIds.add(roleId);
    }
    validateLimits(profileSource.limits);
  }

  const normalized = normalizeOrchestration(source, providers);
  if (source.defaultMode !== "single" && normalized.defaultMode !== source.defaultMode) {
    throw new TeamConfigError("orchestration_active_profile_invalid");
  }
  if (normalized.defaultMode === "consensus") {
    const activeProfile = normalized.profiles.find((profile) => profile.id === normalized.activeProfileId);
    const roleBudget = activeProfile
      ? Math.min(activeProfile.limits.maxTasks, activeProfile.limits.maxAgents)
      : 0;
    if (activeProfile && activeProfile.roles.length > roleBudget) {
      throw new TeamConfigError("team_consensus_role_budget_exceeded");
    }
  }
  return normalized;
}
