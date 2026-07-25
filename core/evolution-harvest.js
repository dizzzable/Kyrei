/**
 * Evolution harvest (proposal-first, observation-only).
 *
 * Turns a single lightweight trajectory digest (see `digestMessagesToTrajectory`
 * in skills-sleep.js) into zero or more EvolutionStore candidate drafts. It is a
 * PURE function — no I/O — mirroring `sleepProposalsFromTrajectories`. The caller
 * (gateway idle tick) persists the drafts via `evolutionStore.create()`.
 *
 * Scope is deliberately narrow and non-mutating: we only emit `reliability-hint`
 * candidates (repeated tool failures / heal handoffs) and, cautiously, `skill`
 * drafts for orphan failure patterns. We NEVER emit `prompt-profile` or
 * `memory-ranking` targets — those sit closer to policy mutation and are out of
 * scope for the harvest layer. Nothing here applies a change; it only journals
 * an observation for later human review.
 */

import { createHash } from "node:crypto";

export const EVOLUTION_HARVEST_VERSION = 1;

const DEFAULT_MAX_PER_TURN = 3;
/** A failure must recur at least this many times before it becomes a hint. */
const MIN_FAILURE_CLUSTER = 2;

function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Mirror EvolutionStore's proposalDigest exactly: sha256 over JSON.stringify of
 * the proposal object. Key order must match what we pass to create(), so the
 * caller dedups reliably — build the proposal object once and hash that object.
 */
function proposalDigest(proposal) {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

/**
 * Derive a safe, human-readable skill name for a playbook draft. Mirrors the
 * executor's slugifySkillName / SAFE_NAME_RE so classifyExecution accepts it as
 * skill_create. Tool names carry a "playbook-" prefix so the draft is obvious.
 * Returns "" if nothing survives sanitisation (caller skips the draft).
 */
function playbookSkillName(tool) {
  const base = `playbook-${String(tool ?? "")}`
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(base) ? base : "";
}

/**
 * Build a SKILL.md *body* (no frontmatter) for a harvested playbook draft.
 * The store's create() wraps this under the requested name, so we must not
 * emit our own `name:` frontmatter (that would fight the wrapper). Mirrors the
 * Skill-sleep draft precedent: observed patterns + a conservative workflow.
 */
function buildPlaybookBody(tool, samples) {
  const observed = (Array.isArray(samples) ? samples : [])
    .slice(0, 5)
    .map((s) => `- ${clip(s, 200)}`);
  return [
    "# Trajectory playbook (draft)",
    "",
    `This skill was **proposed** by evolution harvest after repeated \`${clip(tool, 120)}\` failures`,
    "with no matching skill in play. Human must review, tighten, and enable — never auto-applied.",
    "",
    "## Observed failures",
    ...(observed.length ? observed : ["- (no sample text captured)"]),
    "",
    "## Suggested workflow",
    "1. Ground first: read the relevant files / config before acting.",
    `2. Use \`${clip(tool, 120)}\` deliberately; check its inputs match what the target expects.`,
    "3. On failure: inspect the error, adjust surgically, verify — do not retry blindly.",
    "",
  ].join("\n");
}

/** Group failures by their `toolName:` prefix (the shape digest emits). */
function clusterFailuresByTool(failures) {
  /** @type {Map<string, string[]>} */
  const clusters = new Map();
  for (const entry of Array.isArray(failures) ? failures : []) {
    if (typeof entry !== "string" || !entry) continue;
    const idx = entry.indexOf(":");
    const tool = (idx > 0 ? entry.slice(0, idx) : entry).trim();
    if (!tool) continue;
    const list = clusters.get(tool) ?? [];
    list.push(entry);
    clusters.set(tool, list);
  }
  return clusters;
}

/**
 * @param {import("./skills-sleep.js").TrajectoryDigest} trajectory
 * @param {Set<string> | Iterable<string>} [existingDigests] proposalDigests already journaled
 * @param {{ maxPerTurn?: number }} [options]
 * @returns {Array<object>} create()-ready candidate drafts (deduped, capped)
 */
export function harvestCandidatesFromTrajectory(trajectory, existingDigests, options = {}) {
  const traj = trajectory && typeof trajectory === "object" ? trajectory : {};
  const seen = existingDigests instanceof Set
    ? existingDigests
    : new Set(existingDigests ? Array.from(existingDigests) : []);
  const maxPerTurn = Number.isFinite(options.maxPerTurn)
    ? Math.max(1, Math.min(20, Math.floor(options.maxPerTurn)))
    : DEFAULT_MAX_PER_TURN;

  const sessionId = typeof traj.sessionId === "string" ? traj.sessionId : "";
  const goal = typeof traj.goal === "string" ? traj.goal : "";
  const skillIds = Array.isArray(traj.skillIds) ? traj.skillIds.filter((x) => typeof x === "string") : [];
  const hasSkillContext = skillIds.length > 0
    || (Array.isArray(traj.skillNames) && traj.skillNames.length > 0);

  const candidates = [];
  const localDigests = new Set();

  const push = (draft) => {
    if (candidates.length >= maxPerTurn) return;
    const digest = proposalDigest(draft.proposal);
    if (seen.has(digest) || localDigests.has(digest)) return;
    localDigests.add(digest);
    candidates.push(draft);
  };

  // 1) Repeated failures of the same tool → a reliability hint.
  const clusters = clusterFailuresByTool(traj.failures);
  const orphanTools = [];
  for (const [tool, samples] of clusters) {
    if (samples.length < MIN_FAILURE_CLUSTER) continue;
    const proposal = {
      kind: "tool-failure-pattern",
      tool,
      occurrences: samples.length,
      samples: samples.slice(0, 5).map((s) => clip(s, 200)),
      ...(sessionId ? { sessionId } : {}),
    };
    push({
      target: { kind: "reliability-hint", id: `tool:${clip(tool, 120)}` },
      title: clip(`Repeated ${tool} failures`, 300),
      summary: clip(
        `Tool "${tool}" failed ${samples.length} time(s) in one session${goal ? ` while: ${goal}` : ""}. Review for a recovery hint.`,
        4000,
      ),
      risk: "low",
      proposal,
      provenance: { via: "evolution_harvest", version: EVOLUTION_HARVEST_VERSION, ...(sessionId ? { sessionId } : {}) },
    });
    if (!hasSkillContext) orphanTools.push({ tool, samples });
  }

  // 2) Heal handoff on a failed turn → a reliability hint.
  if (traj.healHandoff === true && traj.success === false) {
    const proposal = {
      kind: "heal-handoff",
      ...(goal ? { goal: clip(goal, 240) } : {}),
      tools: Array.isArray(traj.tools) ? traj.tools.slice(0, 20) : [],
      ...(sessionId ? { sessionId } : {}),
    };
    push({
      target: { kind: "reliability-hint", id: "heal-handoff" },
      title: "Turn escalated to self-heal",
      summary: clip(
        `A turn failed and handed off to self-heal${goal ? ` while: ${goal}` : ""}. Review whether a durable hint could avoid the escalation.`,
        4000,
      ),
      risk: "low",
      proposal,
      provenance: { via: "evolution_harvest", version: EVOLUTION_HARVEST_VERSION, ...(sessionId ? { sessionId } : {}) },
    });
  }

  // 3) Cautious: an orphan failure pattern (no skill in play) → a skill draft.
  //    The proposal now carries a usable name + SKILL.md body so the executor
  //    can `skill_create` it on promotion. Content is a body (no frontmatter):
  //    the store's create() wraps it under the requested name, avoiding a
  //    frontmatter-name mismatch. Still proposal-first — nothing is applied
  //    until a human promotes it.
  for (const { tool, samples } of orphanTools) {
    const name = playbookSkillName(tool);
    if (!name) continue;
    const content = buildPlaybookBody(tool, samples);
    const proposal = {
      kind: "trajectory-playbook",
      tool,
      name,
      content,
      samples: samples.slice(0, 5).map((s) => clip(s, 200)),
      ...(sessionId ? { sessionId } : {}),
    };
    push({
      target: { kind: "skill", id: `playbook:${clip(tool, 120)}` },
      title: clip(`Playbook draft for ${tool} failures`, 300),
      summary: clip(
        `Repeated "${tool}" failures with no matching skill. Draft recovery playbook — review, tighten, and promote to create the skill.`,
        4000,
      ),
      risk: "low",
      proposal,
      provenance: { via: "evolution_harvest", version: EVOLUTION_HARVEST_VERSION, ...(sessionId ? { sessionId } : {}) },
    });
  }

  return candidates.slice(0, maxPerTurn);
}
