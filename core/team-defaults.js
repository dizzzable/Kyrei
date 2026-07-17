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
        instructions:
          "Investigate independently. Prefer local project evidence, then web. Cite paths/URLs. List uncertainties.",
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
        instructions:
          "Stress-test conclusions and proposed plans. Demand evidence. Call out missing tests and failure modes.",
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
        instructions:
          "Turn research into a clear plan: approach, files, risks, acceptance criteria, ordered steps.",
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
