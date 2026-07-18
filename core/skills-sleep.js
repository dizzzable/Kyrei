/**
 * Wave C1 — Skill sleep (SkillOpt-shaped, proposal-only).
 *
 * Offline harvest from recent trajectories → propose skill improvements.
 * Never silent-applies SKILL.md. Writes the same proposal envelope format as
 * skills-curator so review/apply-one UI works unchanged.
 *
 * Trajectories are lightweight digests (not full chat JSON): skill ids used,
 * tool failures, heal handoffs, goals, free-text notes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { skillsCuratorDir, SKILLS_CURATOR_VERSION } from "./skills-curator.js";

export const SKILLS_SLEEP_VERSION = 1;

/**
 * @typedef {object} TrajectoryDigest
 * @property {string} [sessionId]
 * @property {boolean} [success]
 * @property {string[]} [skillIds]
 * @property {string[]} [skillNames]
 * @property {string[]} [tools]
 * @property {string[]} [failures]
 * @property {string[]} [notes]
 * @property {string} [goal]
 * @property {boolean} [healHandoff]
 * @property {string} [status]
 */

/**
 * @typedef {object} SkillsSleepConfig
 * @property {boolean} enabled
 * @property {number} maxTrajectories
 * @property {number} maxProposals
 * @property {number} minFailureCluster
 */

export const DEFAULT_SKILLS_SLEEP_CONFIG = Object.freeze({
  /** Manual sleep is always available via API force; this gates auto/cron later. */
  enabled: true,
  maxTrajectories: 40,
  maxProposals: 24,
  minFailureCluster: 2,
});

/**
 * @param {Partial<SkillsSleepConfig> | null | undefined} value
 * @returns {SkillsSleepConfig}
 */
export function normalizeSkillsSleepConfig(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    enabled: src.enabled !== false,
    maxTrajectories: Number.isFinite(src.maxTrajectories)
      ? Math.max(1, Math.min(200, Math.floor(src.maxTrajectories)))
      : DEFAULT_SKILLS_SLEEP_CONFIG.maxTrajectories,
    maxProposals: Number.isFinite(src.maxProposals)
      ? Math.max(1, Math.min(100, Math.floor(src.maxProposals)))
      : DEFAULT_SKILLS_SLEEP_CONFIG.maxProposals,
    minFailureCluster: Number.isFinite(src.minFailureCluster)
      ? Math.max(1, Math.min(20, Math.floor(src.minFailureCluster)))
      : DEFAULT_SKILLS_SLEEP_CONFIG.minFailureCluster,
  };
}

function clip(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Extract a trajectory digest from gateway-style chat messages (best-effort).
 * @param {Array<{ role?: string, content?: unknown, parts?: unknown }>} messages
 * @param {{ sessionId?: string, status?: string, skillIds?: string[] }} [meta]
 * @returns {TrajectoryDigest}
 */
export function digestMessagesToTrajectory(messages, meta = {}) {
  const list = Array.isArray(messages) ? messages : [];
  /** @type {string[]} */
  const tools = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const skillNames = [];
  let healHandoff = false;
  let goal = "";

  for (const msg of list) {
    const role = msg?.role;
    const textBits = [];
    if (typeof msg?.content === "string") textBits.push(msg.content);
    const parts = Array.isArray(msg?.parts)
      ? msg.parts
      : Array.isArray(msg?.content)
        ? msg.content
        : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = /** @type {Record<string, unknown>} */ (part);
      if (typeof p.text === "string") textBits.push(p.text);
      if (p.type === "tool-call" && typeof p.toolName === "string") {
        tools.push(p.toolName);
        if (p.toolName === "read_skill" || p.toolName === "search_skills") {
          const input = p.input && typeof p.input === "object"
            ? /** @type {Record<string, unknown>} */ (p.input)
            : {};
          if (typeof input.id === "string") skillNames.push(input.id);
          if (typeof input.name === "string") skillNames.push(input.name);
          if (typeof input.query === "string") notes.push(`skill_query:${input.query}`);
        }
      }
      if (p.type === "tool-error") {
        const name = typeof p.toolName === "string" ? p.toolName : "tool";
        const err = typeof p.error === "string" ? p.error : "error";
        failures.push(clip(`${name}: ${err}`, 200));
      }
    }
    const blob = textBits.join("\n");
    if (/KYREI_FAILURE_HANDOFF|heal-handoff|heal_handoff/i.test(blob)) healHandoff = true;
    if (role === "user" && !goal && blob.trim()) goal = clip(blob, 240);
    if (/skill/i.test(blob) && blob.length < 400) notes.push(clip(blob, 160));
  }

  const status = typeof meta.status === "string" ? meta.status : "";
  if (status === "heal_handoff") healHandoff = true;
  const success = status === "complete" || status === "done"
    ? true
    : status === "heal_handoff" || status === "error" || status === "failed"
      ? false
      : failures.length === 0 && !healHandoff;

  return {
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    success,
    skillIds: Array.isArray(meta.skillIds) ? meta.skillIds.filter((x) => typeof x === "string") : [],
    skillNames: [...new Set(skillNames)].slice(0, 20),
    tools: [...new Set(tools)].slice(0, 40),
    failures: failures.slice(0, 20),
    notes: notes.slice(0, 20),
    ...(goal ? { goal } : {}),
    healHandoff,
    ...(status ? { status } : {}),
  };
}

/**
 * Pure proposal generation from trajectories + skill catalog.
 * @param {TrajectoryDigest[]} trajectories
 * @param {Array<{ id: string, name: string, description?: string, enabled?: boolean, owned?: boolean, content?: string, usage?: number }>} skills
 * @param {Partial<SkillsSleepConfig>} [config]
 */
export function sleepProposalsFromTrajectories(trajectories, skills, config = {}) {
  const cfg = normalizeSkillsSleepConfig(config);
  const traj = (Array.isArray(trajectories) ? trajectories : []).slice(0, cfg.maxTrajectories);
  const catalog = Array.isArray(skills) ? skills : [];
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const byName = new Map(catalog.map((s) => [String(s.name || "").toLowerCase(), s]));

  /** @type {Map<string, { skill: object, failures: string[], uses: number, successUses: number, notes: string[] }>} */
  const skillStats = new Map();
  /** @type {Map<string, number>} */
  const toolFailCounts = new Map();
  /** @type {string[]} */
  const orphanPatterns = [];

  const touch = (skill, failure, note, success) => {
    if (!skill) return;
    const key = skill.id;
    const row = skillStats.get(key) ?? {
      skill,
      failures: [],
      uses: 0,
      successUses: 0,
      notes: [],
    };
    row.uses += 1;
    if (success) row.successUses += 1;
    if (failure) row.failures.push(clip(failure, 180));
    if (note) row.notes.push(clip(note, 160));
    skillStats.set(key, row);
  };

  for (const t of traj) {
    const skillRefs = [
      ...(t.skillIds || []),
      ...(t.skillNames || []),
    ];
    const resolved = [];
    for (const ref of skillRefs) {
      const skill = byId.get(ref) || byName.get(String(ref).toLowerCase());
      if (skill) resolved.push(skill);
    }
    if (!resolved.length && (t.tools?.length || t.failures?.length)) {
      const pattern = clip(
        `tools=${(t.tools || []).slice(0, 6).join(",")} fails=${(t.failures || []).slice(0, 2).join(";")}`,
        200,
      );
      if (pattern) orphanPatterns.push(pattern);
    }
    for (const skill of resolved) {
      if (t.failures?.length) {
        for (const f of t.failures.slice(0, 3)) touch(skill, f, t.goal, false);
      } else {
        touch(skill, "", t.goal || t.notes?.[0], t.success !== false);
      }
      if (t.healHandoff) touch(skill, "heal_handoff", "3-strike handoff after skill-guided work", false);
    }
    for (const f of t.failures || []) {
      const tool = f.split(":")[0]?.trim() || "tool";
      toolFailCounts.set(tool, (toolFailCounts.get(tool) || 0) + 1);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const proposals = [];
  let seq = 0;
  const nextId = (kind, skillId) => {
    seq += 1;
    return `ssp_${kind}_${String(skillId).slice(0, 12)}_${seq}`;
  };

  for (const row of skillStats.values()) {
    const skill = row.skill;
    if (row.failures.length >= cfg.minFailureCluster) {
      const uniqueFails = [...new Set(row.failures)].slice(0, 6);
      const recoveryBlock = [
        "",
        "## Sleep-suggested recovery (from trajectories — review before apply)",
        "When tools fail during this skill:",
        ...uniqueFails.map((f) => `- Seen failure: ${f}`),
        "- Do not retry the identical call; re-read context, adjust args, or escalate (KYREI_FAILURE_PROBE → ESCALATE → HANDOFF).",
        "- Prefer dedicated tools over shell for files; verify with diagnostics/tests when the skill claims a fix.",
      ].join("\n");
      const baseContent = typeof skill.content === "string" && skill.content.trim()
        ? skill.content.trim()
        : [
          "---",
          `name: ${skill.name}`,
          `description: ${skill.description || skill.name}`,
          "---",
          "",
          `# ${skill.name}`,
          "",
          skill.description || "",
        ].join("\n");
      const suggestedContent = baseContent.includes("Sleep-suggested recovery")
        ? baseContent
        : `${baseContent.trimEnd()}\n${recoveryBlock}\n`;
      proposals.push({
        id: nextId("fail", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "suggest_patch",
        kind: "sleep_improve",
        reason: "Trajectory failures clustered on this skill",
        detail: clip(`${row.failures.length} failure signals across ${row.uses} uses`, 280),
        patchSummary: "Add recovery / 3-strike guidance from observed tool failures",
        suggestedContent,
        owned: skill.owned === true,
      });
    } else if (row.uses >= 2 && row.successUses === row.uses) {
      const desc = typeof skill.description === "string" ? skill.description.trim() : "";
      if (desc.length < 40 && skill.owned) {
        const evidence = [...new Set(row.notes.filter(Boolean))].slice(0, 3);
        const suggestedDescription = clip(
          [
            desc || `Use when working on ${skill.name}`,
            evidence.length ? `Evidence from sessions: ${evidence.join("; ")}` : "",
            "Trigger only when the user goal matches this skill's domain.",
          ].filter(Boolean).join(" — "),
          400,
        );
        proposals.push({
          id: nextId("thin", skill.id),
          skillId: skill.id,
          skillName: skill.name,
          action: "suggest_patch",
          kind: "sleep_improve",
          reason: "Successful uses but thin description",
          detail: clip(`uses=${row.uses}; improve match triggers`, 280),
          patchSummary: "Enrich description from successful trajectory notes",
          suggestedDescription,
          owned: true,
        });
      }
    }
  }

  // Orphan patterns without a matching skill → review proposal (new skill draft).
  const uniqueOrphans = [...new Set(orphanPatterns)].slice(0, 5);
  if (uniqueOrphans.length >= 1) {
    const draftName = "trajectory-playbook";
    const suggestedContent = [
      "---",
      `name: ${draftName}`,
      "description: Auto-drafted from sessions that lacked a matching skill. Review before enabling.",
      "tags: [sleep, draft]",
      "---",
      "",
      "# Trajectory playbook (draft)",
      "",
      "This skill was **proposed** by Skill sleep from repeated tool patterns without a dedicated skill.",
      "Human must rename, tighten, and enable — never auto-applied.",
      "",
      "## Observed patterns",
      ...uniqueOrphans.map((p) => `- ${p}`),
      "",
      "## Suggested workflow",
      "1. Ground with project_map / grep_search / read_file.",
      "2. Change surgically; verify with tests/diagnostics.",
      "3. On failure: probe → escalate fix note → handoff (no thrash).",
      "",
    ].join("\n");
    proposals.push({
      id: nextId("new", "draft"),
      skillId: "skill_sleep_draft_new_skill",
      skillName: draftName,
      action: "review",
      kind: "sleep_new_skill",
      reason: "Repeated tool patterns without a matching skill",
      detail: clip(`${uniqueOrphans.length} orphan pattern(s); create skill manually from draft`, 280),
      patchSummary: "New skill draft — create via Skills → New, paste suggestedContent",
      suggestedContent,
      owned: false,
    });
  }

  // Hot tools that fail often even without skill attribution
  for (const [tool, count] of toolFailCounts.entries()) {
    if (count < cfg.minFailureCluster + 1) continue;
    if (proposals.length >= cfg.maxProposals) break;
    // Attach to first owned skill that mentions the tool in content/description if any
    const host = catalog.find((s) =>
      s.owned
      && s.enabled !== false
      && (`${s.description || ""} ${s.content || ""}`.toLowerCase().includes(tool.toLowerCase())),
    );
    if (!host) continue;
    if (proposals.some((p) => p.skillId === host.id && p.kind === "sleep_improve")) continue;
    proposals.push({
      id: nextId("tool", host.id),
      skillId: host.id,
      skillName: host.name,
      action: "suggest_patch",
      kind: "sleep_improve",
      reason: `Tool ${tool} failed repeatedly in trajectories`,
      detail: clip(`fail_count=${count}`, 200),
      patchSummary: `Document safe ${tool} usage and recovery`,
      suggestedDescription: clip(
        `${host.description || host.name}. Include robust ${tool} usage and failure recovery.`,
        400,
      ),
      owned: true,
    });
  }

  return proposals.slice(0, cfg.maxProposals);
}

/**
 * Run skill sleep and persist a proposal file (propose-only).
 * @param {object} input
 * @param {string} input.dataDir
 * @param {TrajectoryDigest[]} input.trajectories
 * @param {Array<object>} input.skills
 * @param {Partial<SkillsSleepConfig>} [input.config]
 */
export async function runSkillSleep(input) {
  const cfg = normalizeSkillsSleepConfig(input.config);
  if (!cfg.enabled) {
    return { ok: false, error: "sleep_disabled", proposals: [], proposalPath: "" };
  }
  if (typeof input.dataDir !== "string" || !input.dataDir.trim()) {
    return { ok: false, error: "no_data_dir", proposals: [], proposalPath: "" };
  }

  const proposals = sleepProposalsFromTrajectories(input.trajectories, input.skills, cfg);
  const dir = skillsCuratorDir(input.dataDir);
  await mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const proposalPath = join(dir, `sleep-${stamp}-${randomBytes(3).toString("hex")}.json`);
  const envelope = {
    version: SKILLS_CURATOR_VERSION,
    sleepVersion: SKILLS_SLEEP_VERSION,
    via: "skill_sleep",
    applyMode: "propose",
    at: new Date().toISOString(),
    status: "pending",
    trajectoryCount: Array.isArray(input.trajectories) ? input.trajectories.length : 0,
    skillCount: Array.isArray(input.skills) ? input.skills.length : 0,
    proposals,
  };
  await writeFile(proposalPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  return {
    ok: true,
    via: "skill_sleep",
    proposals,
    proposalPath,
    fileName: proposalPath.split(/[/\\]/).pop(),
    summary: proposals.length
      ? `Skill sleep: ${proposals.length} proposal(s) from ${envelope.trajectoryCount} trajectory digest(s). Review before apply.`
      : `Skill sleep: no proposals (scanned ${envelope.trajectoryCount} trajectory digest(s)).`,
  };
}
