/**
 * Credential-free Pipeline v1 configuration for Kyrei organizations.
 *
 * Pipelines compose existing Team profiles into an evidence-gated DAG. The
 * provider registry and all credentials remain owned by the gateway/Team
 * layer; a department stores only a Team profile id.
 */

import { createHash } from "node:crypto";

export const PIPELINE_VERSION = 1;
export const PIPELINE_STAGE_KINDS = ["department", "approval", "action", "truth-gate"];
export const PIPELINE_ACTIONS = ["workspace.apply"];

export const DEFAULT_PIPELINE_LIMITS = Object.freeze({
  maxInputTokens: 1_000_000,
  maxOutputTokens: 250_000,
  maxTotalTokens: 1_250_000,
  maxCalls: 256,
  maxCostUsd: 100,
  maxWallTimeMs: 14_400_000,
  maxRepairCycles: 3,
  maxAssistanceRequests: 12,
  maxConcurrency: 4,
});

export const DEFAULT_STAGE_RETRY = Object.freeze({
  maxAttempts: 1,
  backoffMs: 1_000,
});

export const MAX_PIPELINE_DEFINITIONS = 256;
export const MAX_PIPELINE_STAGES = 256;
export const MAX_TRUTH_GATE_CHECKS = 32;

const MAX_DEFINITION_NAME = 160;
const MAX_STAGE_NAME = 160;
const MAX_ACTION_ID = 160;
const MAX_STAGE_REFERENCES = 128;
const MAX_CHECK_COMMAND = 512;
const MAX_REVISION = 2_147_483_647;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const STAGE_KIND_SET = new Set(PIPELINE_STAGE_KINDS);
const ACTION_SET = new Set(PIPELINE_ACTIONS);
const LIMIT_RULES = Object.freeze({
  maxInputTokens: { min: 1, max: 10_000_000, fallback: DEFAULT_PIPELINE_LIMITS.maxInputTokens },
  maxOutputTokens: { min: 1, max: 5_000_000, fallback: DEFAULT_PIPELINE_LIMITS.maxOutputTokens },
  maxTotalTokens: { min: 1, max: 10_000_000, fallback: DEFAULT_PIPELINE_LIMITS.maxTotalTokens },
  maxCalls: { min: 1, max: 10_000, fallback: DEFAULT_PIPELINE_LIMITS.maxCalls },
  maxCostUsd: { min: 0.01, max: 1_000_000, fallback: DEFAULT_PIPELINE_LIMITS.maxCostUsd, integer: false },
  maxWallTimeMs: { min: 1_000, max: 604_800_000, fallback: DEFAULT_PIPELINE_LIMITS.maxWallTimeMs },
  maxRepairCycles: { min: 0, max: 16, fallback: DEFAULT_PIPELINE_LIMITS.maxRepairCycles },
  maxAssistanceRequests: { min: 0, max: 64, fallback: DEFAULT_PIPELINE_LIMITS.maxAssistanceRequests },
  maxConcurrency: { min: 1, max: 32, fallback: DEFAULT_PIPELINE_LIMITS.maxConcurrency },
});
const RETRY_RULES = Object.freeze({
  maxAttempts: { min: 1, max: 5, fallback: DEFAULT_STAGE_RETRY.maxAttempts },
  backoffMs: { min: 0, max: 60_000, fallback: DEFAULT_STAGE_RETRY.backoffMs },
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  if (!candidate || CONTROL_CHARACTERS.test(candidate)) return fallback;
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

function normalizeRevision(value) {
  return integer(value, { min: 1, max: MAX_REVISION, fallback: 1 });
}

function normalizeLimits(value) {
  const source = object(value);
  const limits = {};
  for (const [key, rule] of Object.entries(LIMIT_RULES)) {
    const raw = Number.isFinite(source[key]) ? source[key] : rule.fallback;
    const candidate = rule.integer === false ? raw : Math.trunc(raw);
    limits[key] = Math.min(rule.max, Math.max(rule.min, candidate));
  }
  limits.maxInputTokens = Math.min(limits.maxInputTokens, limits.maxTotalTokens);
  limits.maxOutputTokens = Math.min(limits.maxOutputTokens, limits.maxTotalTokens);
  limits.maxConcurrency = Math.min(limits.maxConcurrency, limits.maxCalls);
  limits.maxRepairCycles = Math.min(limits.maxRepairCycles, limits.maxCalls);
  limits.maxAssistanceRequests = Math.min(limits.maxAssistanceRequests, limits.maxCalls);
  return limits;
}

function normalizeRetry(value) {
  const source = object(value);
  return {
    maxAttempts: integer(source.maxAttempts, RETRY_RULES.maxAttempts),
    backoffMs: integer(source.backoffMs, RETRY_RULES.backoffMs),
  };
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

/**
 * Truth-gate check pins. testDigest is frozen at normalize time from
 * { ecosystem, command, cwdPolicy } so runtime can detect config drift.
 */
function normalizeTruthGateChecks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const checks = [];
  for (const raw of value.slice(0, MAX_TRUTH_GATE_CHECKS)) {
    const source = object(raw);
    const id = cleanText(source.id, 64);
    const command = cleanText(source.command, MAX_CHECK_COMMAND);
    const ecosystem = cleanText(source.ecosystem, 64);
    if (!id || !command || seen.has(id)) return null;
    seen.add(id);
    const pin = {
      ecosystem: ecosystem || "custom",
      command,
      cwdPolicy: "workspace-root",
    };
    const testDigest = createHash("sha256")
      .update(JSON.stringify(pin))
      .digest("hex");
    checks.push({
      id,
      command,
      ...(ecosystem ? { ecosystem } : {}),
      testDigest,
    });
  }
  return checks;
}

function teamProfileIds(teamProfiles) {
  const ids = new Set();
  for (const profile of Array.isArray(teamProfiles) ? teamProfiles : []) {
    if (typeof profile === "string") {
      if (ID_PATTERN.test(profile)) ids.add(profile);
      continue;
    }
    if (profile?.enabled !== false && typeof profile?.id === "string" && ID_PATTERN.test(profile.id)) {
      ids.add(profile.id);
    }
  }
  return ids;
}

function normalizeStage(value, index, ids) {
  const source = object(value);
  const requestedId = cleanText(source.id, 64);
  const duplicateId = Boolean(requestedId && ids.has(requestedId));
  const id = uniqueId(source.id, `stage-${index + 1}`, ids);
  const validKind = STAGE_KIND_SET.has(source.kind);
  const kind = validKind ? source.kind : "department";
  const teamProfileId = cleanText(source.teamProfileId, 64);
  const action = cleanText(source.action, MAX_ACTION_ID);
  const issues = [];

  if (duplicateId) issues.push("pipeline_stage_id_duplicate");
  if (!validKind) issues.push("pipeline_stage_kind_invalid");
  if (source.dependsOn !== undefined && !Array.isArray(source.dependsOn)) {
    issues.push("pipeline_stage_dependencies_invalid");
  }
  if (source.allowedHelpFrom !== undefined && !Array.isArray(source.allowedHelpFrom)) {
    issues.push("pipeline_stage_help_invalid");
  }
  if (kind === "department" && !teamProfileId) issues.push("pipeline_stage_profile_invalid");
  if (kind === "action" && (!action || !ACTION_ID_PATTERN.test(action) || !ACTION_SET.has(action))) {
    issues.push("pipeline_stage_action_invalid");
  }
  let checks;
  if (kind === "truth-gate") {
    if (source.checks !== undefined) {
      checks = normalizeTruthGateChecks(source.checks);
      if (checks === null) issues.push("pipeline_stage_checks_invalid");
    } else {
      checks = [];
    }
  } else if (source.checks !== undefined) {
    issues.push("pipeline_stage_fields_invalid");
  }

  return {
    stage: {
      id,
      name: cleanText(source.name, MAX_STAGE_NAME, id),
      kind,
      dependsOn: normalizeStringList(source.dependsOn, MAX_STAGE_REFERENCES, 64),
      allowedHelpFrom: normalizeStringList(source.allowedHelpFrom, MAX_STAGE_REFERENCES, 64),
      retry: normalizeRetry(source.retry),
      ...(kind === "department" ? { teamProfileId } : {}),
      ...(kind === "action" ? { action } : {}),
      ...(kind === "truth-gate" ? { checks: checks ?? [] } : {}),
    },
    issues,
  };
}

function graphFor(stages) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const dependents = new Map(stages.map((stage) => [stage.id, []]));
  for (const stage of stages) {
    for (const dependencyId of stage.dependsOn) {
      if (dependents.has(dependencyId)) dependents.get(dependencyId).push(stage.id);
    }
  }
  return { byId, dependents };
}

function graphHasCycle(stages, byId) {
  const visiting = new Set();
  const visited = new Set();

  function visit(stageId) {
    if (visiting.has(stageId)) return true;
    if (visited.has(stageId)) return false;
    visiting.add(stageId);
    for (const dependencyId of byId.get(stageId)?.dependsOn ?? []) {
      if (byId.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(stageId);
    visited.add(stageId);
    return false;
  }

  return stages.some((stage) => visit(stage.id));
}

function hasAncestor(startId, predicate, byId, stopPredicate = () => false) {
  const seen = new Set();
  const pending = [...(byId.get(startId)?.dependsOn ?? [])];
  while (pending.length) {
    const stageId = pending.pop();
    if (seen.has(stageId)) continue;
    seen.add(stageId);
    const stage = byId.get(stageId);
    if (!stage) continue;
    if (predicate(stage)) return true;
    if (!stopPredicate(stage)) pending.push(...stage.dependsOn);
  }
  return false;
}

function countAncestors(startId, predicate, byId) {
  const seen = new Set();
  const pending = [...(byId.get(startId)?.dependsOn ?? [])];
  let count = 0;
  while (pending.length) {
    const stageId = pending.pop();
    if (seen.has(stageId)) continue;
    seen.add(stageId);
    const stage = byId.get(stageId);
    if (!stage) continue;
    if (predicate(stage)) count += 1;
    pending.push(...stage.dependsOn);
  }
  return count;
}

function actionHasDirectDepartmentApproval(stage, byId) {
  for (const dependencyId of stage.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (dependency?.kind !== "approval") continue;
    if (dependency.dependsOn.some((id) => byId.get(id)?.kind === "department")) {
      return true;
    }
  }
  return false;
}

function hasDescendant(startId, predicate, byId, dependents) {
  const seen = new Set();
  const pending = [...(dependents.get(startId) ?? [])];
  while (pending.length) {
    const stageId = pending.pop();
    if (seen.has(stageId)) continue;
    seen.add(stageId);
    const stage = byId.get(stageId);
    if (!stage) continue;
    if (predicate(stage)) return true;
    pending.push(...(dependents.get(stageId) ?? []));
  }
  return false;
}

function everyInboundPathApproved(startId, byId) {
  const memo = new Map();
  function visit(stageId, approved) {
    const memoKey = `${stageId}:${approved ? "approved" : "open"}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    const stage = byId.get(stageId);
    if (!stage) return false;
    if (stage.kind === "truth-gate") return approved;
    const nextApproved = approved || stage.kind === "approval";
    const result = stage.dependsOn.length === 0
      ? nextApproved
      : stage.dependsOn.every((dependencyId) => visit(dependencyId, nextApproved));
    memo.set(memoKey, result);
    return result;
  }
  const start = byId.get(startId);
  return Boolean(start?.dependsOn.length)
    && start.dependsOn.every((dependencyId) => visit(dependencyId, false));
}

function definitionViolation(definition, availableProfiles) {
  if (!definition.stages.length) return "pipeline_stages_invalid";
  const { byId, dependents } = graphFor(definition.stages);

  for (const stage of definition.stages) {
    if (stage.kind === "department" && !availableProfiles.has(stage.teamProfileId)) {
      return "pipeline_stage_profile_unavailable";
    }
    for (const dependencyId of stage.dependsOn) {
      if (!byId.has(dependencyId) || dependencyId === stage.id) {
        return "pipeline_stage_dependency_unavailable";
      }
    }
    for (const helpId of stage.allowedHelpFrom) {
      if (!byId.has(helpId) || helpId === stage.id) return "pipeline_stage_help_unavailable";
    }
  }

  if (graphHasCycle(definition.stages, byId)) return "pipeline_graph_cycle";

  for (const stage of definition.stages) {
    if (!stage.dependsOn.length && stage.kind !== "department") {
      return "pipeline_transition_unsafe";
    }

    if (stage.allowedHelpFrom.length) {
      if (stage.kind !== "department") return "pipeline_transition_unsafe";
      for (const helpId of stage.allowedHelpFrom) {
        const helpStage = byId.get(helpId);
        if (helpStage?.kind !== "department") return "pipeline_transition_unsafe";
        if (!hasAncestor(stage.id, (candidate) => candidate.id === helpId, byId)) {
          return "pipeline_transition_unsafe";
        }
      }
    }

    if (stage.kind === "approval") {
      const directlyConsumesDepartment = stage.dependsOn.some(
        (dependencyId) => byId.get(dependencyId)?.kind === "department",
      );
      if (!directlyConsumesDepartment || stage.retry.maxAttempts !== 1) {
        return "pipeline_transition_unsafe";
      }
    }

    if (stage.kind === "action") {
      const approvedSinceLastGate = everyInboundPathApproved(stage.id, byId);
      const hasTruthGateAfter = hasDescendant(
        stage.id,
        (candidate) => candidate.kind === "truth-gate",
        byId,
        dependents,
      );
      const hasDirectDepartmentApproval = actionHasDirectDepartmentApproval(stage, byId);
      if (
        !approvedSinceLastGate
        || !hasTruthGateAfter
        || !hasDirectDepartmentApproval
        || stage.retry.maxAttempts !== 1
      ) {
        return "pipeline_transition_unsafe";
      }
    }

    if (stage.kind === "truth-gate") {
      const actionAncestors = countAncestors(
        stage.id,
        (candidate) => candidate.kind === "action",
        byId,
      );
      // Exactly one action ancestor: scalar requiredActionDigest stays unambiguous.
      if (actionAncestors !== 1) return "pipeline_transition_unsafe";
    }
  }

  return "";
}

function normalizeDefinition(value, index, ids, availableProfiles) {
  const source = object(value);
  const id = uniqueId(source.id, `pipeline-${index + 1}`, ids);
  const stageIds = new Set();
  const stages = [];
  const issues = [];
  for (const [stageIndex, rawStage] of (Array.isArray(source.stages) ? source.stages : [])
    .slice(0, MAX_PIPELINE_STAGES)
    .entries()) {
    const normalized = normalizeStage(rawStage, stageIndex, stageIds);
    stages.push(normalized.stage);
    issues.push(...normalized.issues);
  }

  if (source.stages !== undefined && !Array.isArray(source.stages)) {
    issues.push("pipeline_stages_invalid");
  }

  const candidate = {
    id,
    name: cleanText(source.name, MAX_DEFINITION_NAME, id),
    revision: normalizeRevision(source.revision),
    enabled: source.enabled !== false,
    stages,
    limits: normalizeLimits(source.limits),
  };
  const disabledReason = issues[0]
    || definitionViolation(candidate, availableProfiles)
    || (source.enabled === false ? "pipeline_definition_disabled" : "");
  return {
    ...candidate,
    enabled: !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
  };
}

/**
 * Tolerant persisted-config migration. Unsafe or dangling definitions remain
 * visible for repair, but never activate and are never silently retargeted.
 */
export function normalizePipelines(value, teamProfiles = []) {
  const source = object(value);
  const definitionIds = new Set();
  const availableProfiles = teamProfileIds(teamProfiles);
  const definitions = [];
  for (const [index, rawDefinition] of (Array.isArray(source.definitions) ? source.definitions : [])
    .slice(0, MAX_PIPELINE_DEFINITIONS)
    .entries()) {
    const requestedId = normalizeId(object(rawDefinition).id, `pipeline-${index + 1}`);
    const duplicateId = definitionIds.has(requestedId);
    const definition = normalizeDefinition(rawDefinition, index, definitionIds, availableProfiles);
    definitions.push(duplicateId
      ? { ...definition, enabled: false, disabledReason: "pipeline_definition_id_duplicate" }
      : definition);
  }
  const generation = Number.isSafeInteger(source.generation) && source.generation >= 0
    ? source.generation
    : 0;
  return { version: PIPELINE_VERSION, generation, definitions };
}

export class PipelineConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "PipelineConfigError";
    this.code = code;
  }
}

function requireObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PipelineConfigError(code);
  return value;
}

function requireId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) throw new PipelineConfigError(code);
  return value.trim();
}

function validateRequiredText(value, maxLength, code) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.trim().length > maxLength
    || CONTROL_CHARACTERS.test(value)
  ) throw new PipelineConfigError(code);
}

function validateIntegerObject(value, rules, baseCode, { optional = true } = {}) {
  if (value === undefined && optional) return;
  const source = requireObject(value, baseCode);
  for (const [key, rule] of Object.entries(rules)) {
    if (source[key] === undefined) continue;
    const validNumber = rule.integer === false
      ? Number.isFinite(source[key])
      : Number.isInteger(source[key]);
    if (!validNumber || source[key] < rule.min || source[key] > rule.max) {
      throw new PipelineConfigError(`${baseCode}_${key}`);
    }
  }
}

function validateLimits(value) {
  validateIntegerObject(value, LIMIT_RULES, "pipeline_limit");
  if (value === undefined) return;
  const normalized = normalizeLimits(value);
  if (value.maxInputTokens !== undefined && value.maxInputTokens !== normalized.maxInputTokens) {
    throw new PipelineConfigError("pipeline_limit_maxInputTokens");
  }
  if (value.maxOutputTokens !== undefined && value.maxOutputTokens !== normalized.maxOutputTokens) {
    throw new PipelineConfigError("pipeline_limit_maxOutputTokens");
  }
  if (value.maxConcurrency !== undefined && value.maxConcurrency !== normalized.maxConcurrency) {
    throw new PipelineConfigError("pipeline_limit_maxConcurrency");
  }
  if (value.maxRepairCycles !== undefined && value.maxRepairCycles !== normalized.maxRepairCycles) {
    throw new PipelineConfigError("pipeline_limit_maxRepairCycles");
  }
  if (
    value.maxAssistanceRequests !== undefined
    && value.maxAssistanceRequests !== normalized.maxAssistanceRequests
  ) {
    throw new PipelineConfigError("pipeline_limit_maxAssistanceRequests");
  }
}

function validateRetry(value, kind) {
  validateIntegerObject(value, RETRY_RULES, "pipeline_stage_retry");
  if ((kind === "approval" || kind === "action") && value?.maxAttempts !== undefined && value.maxAttempts !== 1) {
    throw new PipelineConfigError("pipeline_transition_unsafe");
  }
}

function validateReferenceList(value, code) {
  if (!Array.isArray(value) || value.length > MAX_STAGE_REFERENCES) {
    throw new PipelineConfigError(code);
  }
  const seen = new Set();
  for (const rawId of value) {
    const id = requireId(rawId, code);
    if (seen.has(id)) throw new PipelineConfigError(`${code}_duplicate`);
    seen.add(id);
  }
}

function validateStage(value, availableProfiles) {
  const source = requireObject(value, "pipeline_stage_invalid");
  requireId(source.id, "pipeline_stage_id_invalid");
  validateRequiredText(source.name, MAX_STAGE_NAME, "pipeline_stage_name_invalid");
  if (!STAGE_KIND_SET.has(source.kind)) throw new PipelineConfigError("pipeline_stage_kind_invalid");
  validateReferenceList(source.dependsOn, "pipeline_stage_dependencies_invalid");
  if (source.allowedHelpFrom !== undefined) {
    validateReferenceList(source.allowedHelpFrom, "pipeline_stage_help_invalid");
  }
  validateRetry(source.retry, source.kind);

  if (source.kind === "department") {
    const profileId = requireId(source.teamProfileId, "pipeline_stage_profile_invalid");
    if (!availableProfiles.has(profileId)) throw new PipelineConfigError("pipeline_stage_profile_unavailable");
    if (source.action !== undefined) throw new PipelineConfigError("pipeline_stage_action_invalid");
    if (source.checks !== undefined) throw new PipelineConfigError("pipeline_stage_fields_invalid");
  } else if (source.kind === "action") {
    validateRequiredText(source.action, MAX_ACTION_ID, "pipeline_stage_action_invalid");
    if (!ACTION_ID_PATTERN.test(source.action.trim()) || !ACTION_SET.has(source.action.trim())) {
      throw new PipelineConfigError("pipeline_stage_action_invalid");
    }
    if (source.teamProfileId !== undefined) throw new PipelineConfigError("pipeline_stage_profile_invalid");
    if (source.checks !== undefined) throw new PipelineConfigError("pipeline_stage_fields_invalid");
  } else if (source.kind === "truth-gate") {
    if (source.teamProfileId !== undefined || source.action !== undefined) {
      throw new PipelineConfigError("pipeline_stage_fields_invalid");
    }
    if (source.checks !== undefined) {
      if (normalizeTruthGateChecks(source.checks) === null) {
        throw new PipelineConfigError("pipeline_stage_checks_invalid");
      }
    }
  } else if (source.teamProfileId !== undefined || source.action !== undefined || source.checks !== undefined) {
    throw new PipelineConfigError("pipeline_stage_fields_invalid");
  }
}

/** Strict validation for an atomic Pipeline settings PUT boundary. */
export function validatePipelinesInput(value, teamProfiles = []) {
  const source = requireObject(value, "pipelines_invalid");
  if (source.version !== PIPELINE_VERSION) throw new PipelineConfigError("pipeline_version_invalid");
  if (
    source.generation !== undefined
    && (!Number.isSafeInteger(source.generation) || source.generation < 0 || source.generation > MAX_GENERATION)
  ) {
    throw new PipelineConfigError("pipeline_generation_invalid");
  }
  if (!Array.isArray(source.definitions) || source.definitions.length > MAX_PIPELINE_DEFINITIONS) {
    throw new PipelineConfigError("pipeline_definitions_invalid");
  }

  const availableProfiles = teamProfileIds(teamProfiles);
  const definitionIds = new Set();
  for (const rawDefinition of source.definitions) {
    const definition = requireObject(rawDefinition, "pipeline_definition_invalid");
    const definitionId = requireId(definition.id, "pipeline_definition_id_invalid");
    if (definitionIds.has(definitionId)) throw new PipelineConfigError("pipeline_definition_id_duplicate");
    definitionIds.add(definitionId);
    validateRequiredText(definition.name, MAX_DEFINITION_NAME, "pipeline_definition_name_invalid");
    if (!Number.isInteger(definition.revision) || definition.revision < 1 || definition.revision > MAX_REVISION) {
      throw new PipelineConfigError("pipeline_definition_revision_invalid");
    }
    if (typeof definition.enabled !== "boolean") {
      throw new PipelineConfigError("pipeline_definition_enabled_invalid");
    }
    if (!Array.isArray(definition.stages) || definition.stages.length === 0 || definition.stages.length > MAX_PIPELINE_STAGES) {
      throw new PipelineConfigError("pipeline_stages_invalid");
    }

    const stageIds = new Set();
    for (const rawStage of definition.stages) {
      validateStage(rawStage, availableProfiles);
      const stageId = rawStage.id.trim();
      if (stageIds.has(stageId)) throw new PipelineConfigError("pipeline_stage_id_duplicate");
      stageIds.add(stageId);
    }
    validateLimits(definition.limits);
  }

  const normalized = normalizePipelines(source, teamProfiles);
  for (const definition of normalized.definitions) {
    if (definition.disabledReason && definition.disabledReason !== "pipeline_definition_disabled") {
      throw new PipelineConfigError(definition.disabledReason);
    }
  }
  return normalized;
}

/**
 * Safe starter DAG for a coding organization. Repairs are runtime-controlled
 * by maxRepairCycles; the persisted graph itself stays acyclic.
 */
export function createDefaultCodingPipeline(profileIds) {
  const source = requireObject(profileIds, "pipeline_default_profiles_invalid");
  const research = requireId(source.research, "pipeline_default_profiles_invalid");
  const planning = requireId(source.planning, "pipeline_default_profiles_invalid");
  const execution = requireId(source.execution, "pipeline_default_profiles_invalid");
  const verification = requireId(source.verification, "pipeline_default_profiles_invalid");

  return {
    id: "coding-product",
    name: "Coding product pipeline",
    revision: 1,
    enabled: true,
    stages: [
      {
        id: "research",
        name: "Research",
        kind: "department",
        teamProfileId: research,
        dependsOn: [],
        allowedHelpFrom: [],
        retry: { ...DEFAULT_STAGE_RETRY, maxAttempts: 2 },
      },
      {
        id: "planning",
        name: "Plan",
        kind: "department",
        teamProfileId: planning,
        dependsOn: ["research"],
        allowedHelpFrom: ["research"],
        retry: { ...DEFAULT_STAGE_RETRY, maxAttempts: 2 },
      },
      {
        id: "approve-plan",
        name: "Approve plan",
        kind: "approval",
        dependsOn: ["planning"],
        allowedHelpFrom: [],
        retry: { ...DEFAULT_STAGE_RETRY },
      },
      {
        id: "implementation",
        name: "Implement",
        kind: "department",
        teamProfileId: execution,
        dependsOn: ["approve-plan"],
        allowedHelpFrom: ["research", "planning"],
        retry: { ...DEFAULT_STAGE_RETRY, maxAttempts: 2 },
      },
      {
        id: "approve-implementation",
        name: "Approve implementation",
        kind: "approval",
        dependsOn: ["implementation"],
        allowedHelpFrom: [],
        retry: { ...DEFAULT_STAGE_RETRY },
      },
      {
        id: "apply-changes",
        name: "Apply changes",
        kind: "action",
        action: "workspace.apply",
        dependsOn: ["approve-implementation"],
        allowedHelpFrom: [],
        retry: { ...DEFAULT_STAGE_RETRY },
      },
      {
        id: "verification",
        name: "Verify",
        kind: "department",
        teamProfileId: verification,
        dependsOn: ["apply-changes"],
        allowedHelpFrom: ["research"],
        retry: { ...DEFAULT_STAGE_RETRY, maxAttempts: 2 },
      },
      {
        id: "acceptance",
        name: "Acceptance gate",
        kind: "truth-gate",
        dependsOn: ["verification"],
        allowedHelpFrom: [],
        retry: { ...DEFAULT_STAGE_RETRY },
        checks: [
          { id: "unit", command: "npm test --silent", ecosystem: "node" },
        ],
      },
    ],
    limits: { ...DEFAULT_PIPELINE_LIMITS },
  };
}
