/**
 * Out-of-the-box Team + prompt-profile defaults.
 *
 * Fresh installs get a ready coding team and reusable role prompts without
 * forcing Team mode on (defaultMode stays "single" until the user enables it).
 * Users may freely edit/replace/delete everything; built-ins only fill gaps.
 */

import { DEFAULT_TEAM_LIMITS } from "./team-config.js";

/** Stable ids — never renumber; users may customize bodies in-place. */
export const BUILTIN_PROMPT_PROFILE_IDS = Object.freeze({
  main: "kyrei-main",
  researcher: "kyrei-researcher",
  critic: "kyrei-critic",
  architect: "kyrei-architect",
});

export const BUILTIN_TEAM_PROFILE_ID = "kyrei-coding-team";

/**
 * Portable English system addenda (appended under Kyrei immutable policy).
 * Keep dense and tool-aligned; not product marketing copy.
 */
export const BUILTIN_PROMPT_PROFILES = Object.freeze([
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.main,
    name: "Main coding agent",
    description: "Default style for the acting agent: grounded edits, verify, no thrash.",
    systemPrompt: [
      "MISSION: Deliver the user's software outcome in the current workspace, not merely advice about it.",
      "METHOD: Ground claims in files and tool results; read before editing; make the smallest coherent change; parallelize independent evidence gathering when useful.",
      "VERIFICATION: Run the narrowest checks that prove the change, inspect their output, and keep working when they fail.",
      "BOUNDARY: Preserve unrelated work, secrets, approvals, workspace limits, and the immutable Kyrei safety contract.",
      "HANDOFF: Match the user's language and report outcome, changed paths, verification evidence, and only material remaining risk.",
    ].join(" "),
  },
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.researcher,
    name: "Researcher",
    description: "Broad code+web evidence gathering; reports sources and uncertainty.",
    systemPrompt: [
      "MISSION: Resolve the assigned uncertainty with inspectable local and external evidence.",
      "METHOD: Map the relevant code and memory first; use the web only when external truth matters; fetch primary sources before treating search leads as facts.",
      "VERIFICATION: Separate observed evidence, inference, and unknowns; cite exact paths or direct source URLs.",
      "BOUNDARY: Investigate only the assigned slice and do not claim or apply workspace changes.",
      "HANDOFF: Return concise findings, confidence, contradictions, and what was not checked so the lead can decide or act.",
    ].join(" "),
  },
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.critic,
    name: "Critic",
    description: "Adversarial review of claims, risks, and missing checks.",
    systemPrompt: [
      "MISSION: Try to falsify the proposed result before the lead relies on it.",
      "METHOD: Trace claims to code, contracts, tests, and primary sources; prioritize correctness, security, migration, and failure paths over style.",
      "VERIFICATION: Reproduce or construct concrete counterexamples and identify the missing check that would settle each disputed claim.",
      "BOUNDARY: Do not broaden product scope or apply fixes; propose a patch artifact only when the assigned task explicitly requests one.",
      "HANDOFF: Rank findings by impact, include evidence, and state whether the result is ready, conditionally ready, or not ready.",
    ].join(" "),
  },
  {
    id: BUILTIN_PROMPT_PROFILE_IDS.architect,
    name: "Architect",
    description: "Design options, tradeoffs, and a decision-complete plan.",
    systemPrompt: [
      "MISSION: Convert evidence and user intent into a decision-complete implementation shape.",
      "METHOD: Eliminate discoverable unknowns, define boundaries and data flow, and compare no more than two viable approaches when a real tradeoff exists.",
      "VERIFICATION: Name affected modules, invariants, acceptance checks, rollout risks, and the evidence behind the recommendation.",
      "BOUNDARY: Do not write product code; preserve human ownership of decisions that materially change scope or product behavior.",
      "HANDOFF: Return the recommended approach, rejected alternative with reason, ordered steps, and explicit questions only for blocking forks.",
    ].join(" "),
  },
]);

/** Default capabilities for built-in team roles (still read-only / no shell). */
export const BUILTIN_ROLE_CAPABILITIES = Object.freeze([
  "workspace.read",
  "memory.read",
  "web",
]);

/**
 * @param {{ providerId: string, modelId: string } | null | undefined} model
 * @returns {object | null} Team profile or null if model missing
 */
export function buildBuiltinCodingTeamProfile(model) {
  if (!model?.providerId || !model?.modelId) return null;
  const ref = { providerId: model.providerId, modelId: model.modelId };
  return {
    id: BUILTIN_TEAM_PROFILE_ID,
    name: "Coding team",
    workflow: "supervisor",
    enabled: true,
    limits: { ...DEFAULT_TEAM_LIMITS },
    roles: [
      {
        id: "researcher",
        name: "Researcher",
        description: "Code and web research; returns source-backed findings.",
        instructions: "",
        model: { ...ref },
        skillIds: [],
        capabilities: [...BUILTIN_ROLE_CAPABILITIES],
        canSpawn: false,
        maxChildren: 0,
        promptProfileId: BUILTIN_PROMPT_PROFILE_IDS.researcher,
      },
      {
        id: "critic",
        name: "Critic",
        description: "Reviews claims, risks, and gaps before the acting agent commits.",
        instructions: "",
        model: { ...ref },
        skillIds: [],
        capabilities: [...BUILTIN_ROLE_CAPABILITIES],
        canSpawn: false,
        maxChildren: 0,
        promptProfileId: BUILTIN_PROMPT_PROFILE_IDS.critic,
      },
      {
        id: "architect",
        name: "Architect",
        description: "Structures options into a decision-complete plan.",
        instructions: "",
        model: { ...ref },
        skillIds: [],
        capabilities: [...BUILTIN_ROLE_CAPABILITIES],
        canSpawn: false,
        maxChildren: 0,
        promptProfileId: BUILTIN_PROMPT_PROFILE_IDS.architect,
      },
    ],
  };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Pick a provider/model pair for seeding. Secrets are separate from registry
 * config, so we only require an enabled provider with a known model id.
 */
function readyModelRef(providers, preferred) {
  const list = Array.isArray(providers) ? providers : [];
  if (preferred?.providerId && preferred?.modelId) {
    const provider = list.find((p) => p.id === preferred.providerId && p.enabled);
    if (provider?.models?.some((m) => m.id === preferred.modelId)) {
      return { providerId: preferred.providerId, modelId: preferred.modelId };
    }
  }
  for (const provider of list) {
    if (!provider?.enabled) continue;
    const modelId = provider.models?.[0]?.id;
    if (modelId) return { providerId: provider.id, modelId };
  }
  return null;
}

/**
 * Merge missing built-in prompt profiles into engine config.
 * Never overwrites an existing id (user customizations win).
 * Does not force activePromptProfileId — built-in main stays optional.
 */
export function ensureBuiltinPromptProfiles(engine) {
  const source = object(engine);
  const existing = Array.isArray(source.promptProfiles) ? [...source.promptProfiles] : [];
  const ids = new Set(
    existing
      .filter((p) => p && typeof p === "object" && typeof p.id === "string")
      .map((p) => p.id),
  );
  let changed = false;
  for (const builtin of BUILTIN_PROMPT_PROFILES) {
    if (ids.has(builtin.id)) continue;
    existing.push({ ...builtin });
    ids.add(builtin.id);
    changed = true;
  }
  if (!changed) return source;
  return { ...source, promptProfiles: existing };
}

/**
 * When orchestration has no profiles and a ready model exists, seed the
 * built-in coding team. Leaves defaultMode as-is (usually "single") so
 * chat stays single-agent until the user enables Team.
 *
 * @param {object} orchestration already normalized
 * @param {object[]} providers
 * @param {{ providerId?: string, modelId?: string }} [preferred]
 */
export function ensureBuiltinTeamOrchestration(orchestration, providers, preferred) {
  const current = object(orchestration);
  const profiles = Array.isArray(current.profiles) ? current.profiles : [];
  if (profiles.length > 0) return current;

  const model = readyModelRef(providers, preferred);
  const team = buildBuiltinCodingTeamProfile(model);
  if (!team) return current;

  return {
    defaultMode: current.defaultMode === "team" || current.defaultMode === "consensus"
      ? current.defaultMode
      : "single",
    activeProfileId: team.id,
    profiles: [team],
  };
}
