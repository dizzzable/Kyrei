/**
 * Optional Skills curator (Hermes Skill Curator analogue).
 *
 * Proposal-first hygiene for the local skills catalog:
 * - mark stale / never-used skills for disable
 * - flag duplicate names and thin descriptions
 * - optional LLM-suggest patch (description / SKILL.md draft) — never auto-applied
 * - never rewrite SKILL.md or delete skills automatically
 *
 * Default: disabled. When apply_safe is chosen, only stale `disable` actions run.
 * LLM patches require explicit apply-one with action "apply_patch".
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export const SKILLS_CURATOR_VERSION = 1;

/** @typedef {"propose" | "apply_safe"} SkillsCuratorApplyMode */
/** @typedef {"disable" | "enable" | "review" | "suggest_patch" | "apply_patch"} SkillsCuratorAction */
/** @typedef {"worker" | "session" | "default"} SkillsCuratorModelSource */
/**
 * @typedef {object} SkillsCuratorConfig
 * @property {boolean} enabled
 * @property {SkillsCuratorApplyMode} applyMode
 * @property {number} staleDays
 * @property {number} maxProposals
 * @property {boolean} useLlm
 * @property {SkillsCuratorModelSource} modelSource
 * @property {number} maxLlmSkills
 * @property {number} maxSkillChars
 */
/**
 * @typedef {object} SkillSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {boolean} enabled
 * @property {number} [usage]
 * @property {string} [lastUsedAt]
 * @property {string} [provenance]
 * @property {boolean} [owned]
 * @property {string} [content]
 */
/**
 * @typedef {object} SkillsCuratorProposal
 * @property {string} id
 * @property {string} skillId
 * @property {string} skillName
 * @property {SkillsCuratorAction} action
 * @property {string} reason
 * @property {string} [detail]
 * @property {"stale"|"never_used"|"duplicate_name"|"thin_description"|"disabled_hot"|"llm_patch"} kind
 * @property {string} [suggestedDescription]
 * @property {string} [suggestedContent]
 * @property {string} [patchSummary]
 * @property {boolean} [owned]
 */

export const DEFAULT_SKILLS_CURATOR_CONFIG = Object.freeze({
  enabled: false,
  applyMode: "propose",
  staleDays: 90,
  maxProposals: 40,
  /** Second-layer LLM patch suggestions — off unless user opts in. */
  useLlm: false,
  modelSource: "worker",
  maxLlmSkills: 6,
  maxSkillChars: 6_000,
});

/**
 * @param {Partial<SkillsCuratorConfig> | null | undefined} value
 * @returns {SkillsCuratorConfig}
 */
export function normalizeSkillsCuratorConfig(value) {
  const src = value && typeof value === "object" ? value : {};
  const staleDays = Number.isFinite(src.staleDays)
    ? Math.max(7, Math.min(3650, Math.floor(src.staleDays)))
    : DEFAULT_SKILLS_CURATOR_CONFIG.staleDays;
  const maxProposals = Number.isFinite(src.maxProposals)
    ? Math.max(1, Math.min(200, Math.floor(src.maxProposals)))
    : DEFAULT_SKILLS_CURATOR_CONFIG.maxProposals;
  const maxLlmSkills = Number.isFinite(src.maxLlmSkills)
    ? Math.max(1, Math.min(20, Math.floor(src.maxLlmSkills)))
    : DEFAULT_SKILLS_CURATOR_CONFIG.maxLlmSkills;
  const maxSkillChars = Number.isFinite(src.maxSkillChars)
    ? Math.max(500, Math.min(40_000, Math.floor(src.maxSkillChars)))
    : DEFAULT_SKILLS_CURATOR_CONFIG.maxSkillChars;
  const applyMode = src.applyMode === "apply_safe" ? "apply_safe" : "propose";
  const modelSource = src.modelSource === "session" || src.modelSource === "default"
    ? src.modelSource
    : "worker";
  return {
    enabled: src.enabled === true,
    applyMode,
    staleDays,
    maxProposals,
    useLlm: src.useLlm === true,
    modelSource,
    maxLlmSkills,
    maxSkillChars,
  };
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function skillsCuratorDir(dataDir) {
  return join(dataDir, "skills-curator");
}

/**
 * @param {string} s
 * @param {number} max
 */
function clip(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Pure heuristic proposals — no I/O, no network.
 * @param {SkillSnapshot[]} skills
 * @param {Partial<SkillsCuratorConfig>} [config]
 * @param {{ now?: Date }} [opts]
 * @returns {SkillsCuratorProposal[]}
 */
export function heuristicSkillsProposals(skills, config = {}, opts = {}) {
  const cfg = normalizeSkillsCuratorConfig(config);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowMs = now.getTime();
  const staleMs = cfg.staleDays * 24 * 60 * 60 * 1000;
  const list = Array.isArray(skills) ? skills : [];
  /** @type {SkillsCuratorProposal[]} */
  const out = [];
  let seq = 0;
  const nextId = (kind, skillId) => {
    seq += 1;
    return `scp_${kind}_${String(skillId).slice(0, 12)}_${seq}`;
  };

  /** @type {Map<string, SkillSnapshot[]>} */
  const byName = new Map();
  for (const skill of list) {
    if (!skill || typeof skill.id !== "string" || typeof skill.name !== "string") continue;
    const key = skill.name.trim().toLowerCase();
    if (!key) continue;
    const bucket = byName.get(key) ?? [];
    bucket.push(skill);
    byName.set(key, bucket);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const skill of group) {
      const others = group.filter((s) => s.id !== skill.id).map((s) => s.name).join(", ");
      out.push({
        id: nextId("dup", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "review",
        kind: "duplicate_name",
        reason: "Duplicate skill name",
        detail: clip(`Same name as: ${others}`, 280),
        owned: skill.owned === true,
      });
    }
  }

  for (const skill of list) {
    if (!skill || typeof skill.id !== "string" || typeof skill.name !== "string") continue;
    const usage = Number.isFinite(skill.usage) ? Math.max(0, Math.floor(skill.usage)) : 0;
    const desc = typeof skill.description === "string" ? skill.description.trim() : "";
    const lastUsedMs = typeof skill.lastUsedAt === "string" ? Date.parse(skill.lastUsedAt) : NaN;
    const hasLastUsed = Number.isFinite(lastUsedMs);
    const ageMs = hasLastUsed ? nowMs - lastUsedMs : null;

    if (skill.enabled && hasLastUsed && ageMs != null && ageMs >= staleMs) {
      out.push({
        id: nextId("stale", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "disable",
        kind: "stale",
        reason: `Not used for ${cfg.staleDays}+ days`,
        detail: clip(`Last used ${skill.lastUsedAt}; usage=${usage}`, 280),
        owned: skill.owned === true,
      });
    } else if (skill.enabled && usage === 0 && !hasLastUsed) {
      out.push({
        id: nextId("never", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "review",
        kind: "never_used",
        reason: "Never used (no usage recorded)",
        detail: "Consider disabling if it is noise in skill matching.",
        owned: skill.owned === true,
      });
    }

    if (skill.enabled && desc.length > 0 && desc.length < 24) {
      out.push({
        id: nextId("thin", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "review",
        kind: "thin_description",
        reason: "Thin description",
        detail: clip(desc, 160),
        owned: skill.owned === true,
      });
    } else if (skill.enabled && !desc) {
      out.push({
        id: nextId("nodesc", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "review",
        kind: "thin_description",
        reason: "Missing description",
        detail: "Agents match skills by description; add a clear trigger summary.",
        owned: skill.owned === true,
      });
    }

    if (!skill.enabled && usage >= 3 && hasLastUsed && ageMs != null && ageMs < staleMs / 2) {
      out.push({
        id: nextId("hot", skill.id),
        skillId: skill.id,
        skillName: skill.name,
        action: "enable",
        kind: "disabled_hot",
        reason: "Disabled but recently used",
        detail: clip(`usage=${usage}; lastUsed=${skill.lastUsedAt}`, 280),
        owned: skill.owned === true,
      });
    }
  }

  const rank = { disable: 0, enable: 1, review: 2, suggest_patch: 3, apply_patch: 4 };
  out.sort((a, b) => (rank[a.action] - rank[b.action]) || a.skillName.localeCompare(b.skillName));

  const seen = new Set();
  const deduped = [];
  for (const p of out) {
    const key = `${p.skillId}\0${p.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
    if (deduped.length >= cfg.maxProposals) break;
  }
  return deduped;
}

/**
 * Pick owned skills most worth an LLM improve pass.
 * Prefers heuristic candidates (thin / never_used) then other owned enabled skills.
 * @param {SkillSnapshot[]} skills
 * @param {SkillsCuratorProposal[]} heuristic
 * @param {SkillsCuratorConfig} cfg
 * @returns {SkillSnapshot[]}
 */
export function selectSkillsForLlm(skills, heuristic, cfg) {
  const list = Array.isArray(skills) ? skills : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const priorityKinds = new Set(["thin_description", "never_used", "duplicate_name"]);
  const orderedIds = [];
  for (const p of heuristic) {
    if (!priorityKinds.has(p.kind)) continue;
    if (!orderedIds.includes(p.skillId)) orderedIds.push(p.skillId);
  }
  for (const skill of list) {
    if (!skill?.owned || !skill.enabled) continue;
    if (!orderedIds.includes(skill.id)) orderedIds.push(skill.id);
  }
  const selected = [];
  for (const id of orderedIds) {
    const skill = byId.get(id);
    if (!skill || skill.owned !== true) continue;
    if (typeof skill.content !== "string" || !skill.content.trim()) continue;
    selected.push(skill);
    if (selected.length >= cfg.maxLlmSkills) break;
  }
  return selected;
}

/**
 * Parse LLM JSON suggestions into proposals. Pure (testable).
 * @param {string} text
 * @param {SkillSnapshot[]} candidates
 * @returns {SkillsCuratorProposal[]}
 */
export function parseLlmSkillSuggestions(text, candidates) {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions
    : Array.isArray(parsed)
      ? parsed
      : [];
  const byId = new Map((candidates || []).map((s) => [s.id, s]));
  const byName = new Map(
    (candidates || []).map((s) => [String(s.name || "").trim().toLowerCase(), s]),
  );
  /** @type {SkillsCuratorProposal[]} */
  const out = [];
  let seq = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const skillId = typeof raw.skillId === "string" ? raw.skillId : "";
    const skillName = typeof raw.skillName === "string" ? raw.skillName.trim() : "";
    const skill = (skillId && byId.get(skillId))
      || (skillName && byName.get(skillName.toLowerCase()))
      || null;
    if (!skill) continue;
    const suggestedDescription = typeof raw.suggestedDescription === "string"
      ? clip(raw.suggestedDescription, 2_000)
      : "";
    let suggestedContent = typeof raw.suggestedContent === "string"
      ? raw.suggestedContent.replace(/\0/g, "").trim()
      : "";
    if (suggestedContent.length > 40_000) suggestedContent = suggestedContent.slice(0, 40_000);
    if (!suggestedDescription && !suggestedContent) continue;
    // Reject rename attempts in frontmatter.
    if (suggestedContent) {
      const nameMatch = /^---[\s\S]*?\nname:\s*["']?([^\n"']+)/i.exec(suggestedContent);
      if (nameMatch) {
        const proposedName = nameMatch[1].trim();
        if (proposedName && proposedName !== skill.name) continue;
      }
    }
    seq += 1;
    const summary = typeof raw.summary === "string"
      ? clip(raw.summary, 400)
      : (suggestedDescription ? "Improve description / instructions" : "Improve SKILL.md body");
    out.push({
      id: `scp_llm_${String(skill.id).slice(0, 12)}_${seq}`,
      skillId: skill.id,
      skillName: skill.name,
      action: "suggest_patch",
      kind: "llm_patch",
      reason: "LLM suggested skill improvement",
      detail: summary,
      patchSummary: summary,
      ...(suggestedDescription ? { suggestedDescription } : {}),
      ...(suggestedContent ? { suggestedContent } : {}),
      owned: skill.owned === true,
    });
  }
  return out;
}

/**
 * One-shot LLM pass over a small skill set. Fail-open → empty array.
 * @param {object} input
 * @param {SkillSnapshot[]} input.skills
 * @param {SkillsCuratorConfig} input.config
 * @param {import("ai").LanguageModel} input.model
 * @param {typeof import("ai").generateText} [input.generateText]
 * @param {AbortSignal} [input.abortSignal]
 * @param {SkillsCuratorProposal[]} [input.heuristic]
 */
export async function llmSkillsProposals(input) {
  const cfg = normalizeSkillsCuratorConfig(input.config);
  if (!cfg.useLlm || !input.model) return [];
  const heuristic = Array.isArray(input.heuristic) ? input.heuristic : [];
  const candidates = selectSkillsForLlm(input.skills, heuristic, cfg);
  if (!candidates.length) return [];

  const generate = input.generateText;
  if (typeof generate !== "function") return [];

  const catalog = candidates.map((s) => ({
    skillId: s.id,
    skillName: s.name,
    description: clip(s.description || "", 400),
    content: clip(s.content || "", cfg.maxSkillChars),
  }));

  try {
    const { text } = await generate({
      model: input.model,
      maxRetries: 0,
      maxOutputTokens: 2_400,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      messages: [
        {
          role: "system",
          content: [
            "You improve Agent Skills (SKILL.md) for a local coding agent.",
            "Suggest clearer trigger descriptions and tighter instruction bodies.",
            "Do NOT rename skills. Keep frontmatter name identical if present.",
            "Do NOT invent secrets, API keys, or external network calls.",
            "Reply with ONE JSON object only:",
            '{"suggestions":[{"skillId":string,"skillName":string,"summary":string,"suggestedDescription":string,"suggestedContent":string}]}',
            "suggestedContent is optional full SKILL.md (frontmatter + body). Max 6 suggestions.",
            "Only include skills that truly need improvement; empty suggestions array is ok.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Improve these skills when useful:\n${JSON.stringify(catalog, null, 2)}`,
        },
      ],
    });
    return parseLlmSkillSuggestions(text, candidates).slice(0, cfg.maxLlmSkills);
  } catch {
    return [];
  }
}

/**
 * @param {string} dataDir
 * @param {{ setEnabled: (id: string, enabled: boolean) => Promise<unknown> }} skillsStore
 * @param {SkillsCuratorProposal[]} proposals
 * @param {SkillsCuratorApplyMode} applyMode
 */
export async function applySkillsCuratorProposals(dataDir, skillsStore, proposals, applyMode) {
  /** @type {string[]} */
  const applied = [];
  /** @type {Array<{ proposalId: string, skillId: string, error: string }>} */
  const errors = [];
  if (applyMode !== "apply_safe") {
    return { applied, errors };
  }
  for (const p of proposals) {
    if (!p || p.action !== "disable" || p.kind !== "stale") continue;
    // Never auto-apply enable, review, or LLM patches.
    try {
      await skillsStore.setEnabled(p.skillId, false);
      applied.push(p.id);
    } catch (error) {
      errors.push({
        proposalId: p.id,
        skillId: p.skillId,
        error: error?.message ?? "apply_failed",
      });
    }
  }
  void dataDir;
  return { applied, errors };
}

/**
 * @param {object} input
 * @param {string} input.dataDir
 * @param {SkillSnapshot[]} input.skills
 * @param {Partial<SkillsCuratorConfig>} [input.config]
 * @param {{ setEnabled: (id: string, enabled: boolean) => Promise<unknown>, update?: Function }} input.skillsStore
 * @param {SkillsCuratorApplyMode} [input.applyModeOverride]
 * @param {Date} [input.now]
 * @param {import("ai").LanguageModel} [input.model]
 * @param {typeof import("ai").generateText} [input.generateText]
 * @param {AbortSignal} [input.abortSignal]
 */
export async function curateSkills(input) {
  const cfg = normalizeSkillsCuratorConfig(input.config);
  if (!cfg.enabled) {
    return {
      ok: false,
      via: "heuristic",
      proposals: [],
      applied: [],
      errors: [],
      error: "curator_disabled",
    };
  }
  if (typeof input.dataDir !== "string" || !input.dataDir.trim()) {
    return {
      ok: false,
      via: "heuristic",
      proposals: [],
      applied: [],
      errors: [],
      error: "no_data_dir",
    };
  }

  const applyMode = input.applyModeOverride === "apply_safe" || input.applyModeOverride === "propose"
    ? input.applyModeOverride
    : cfg.applyMode;

  let via = "heuristic";
  let proposals = heuristicSkillsProposals(input.skills, cfg, { now: input.now });

  if (cfg.useLlm && input.model && typeof input.generateText === "function") {
    const llm = await llmSkillsProposals({
      skills: input.skills,
      config: cfg,
      model: input.model,
      generateText: input.generateText,
      abortSignal: input.abortSignal,
      heuristic: proposals,
    });
    if (llm.length) {
      // Merge: keep heuristic, append LLM patches. When capping, prefer keeping llm_patch
      // proposals (do not slice them off the end).
      const seenLlm = new Set();
      for (const p of llm) {
        if (seenLlm.has(p.skillId)) continue;
        seenLlm.add(p.skillId);
        proposals.push(p);
      }
      if (proposals.length > cfg.maxProposals) {
        const llmPatches = proposals.filter((p) => p.kind === "llm_patch");
        const rest = proposals.filter((p) => p.kind !== "llm_patch");
        const llmKeep = llmPatches.slice(0, Math.min(llmPatches.length, cfg.maxLlmSkills, cfg.maxProposals));
        const restKeep = rest.slice(0, Math.max(0, cfg.maxProposals - llmKeep.length));
        proposals = [...restKeep, ...llmKeep];
      }
      via = "llm";
    } else {
      via = "heuristic_fallback";
    }
  }

  const dir = skillsCuratorDir(input.dataDir);
  await mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const proposalPath = join(dir, `proposal-${stamp}-${randomBytes(3).toString("hex")}.json`);
  const envelope = {
    version: SKILLS_CURATOR_VERSION,
    via,
    applyMode,
    at: new Date().toISOString(),
    status: applyMode === "propose" ? "pending" : "applied",
    config: {
      staleDays: cfg.staleDays,
      maxProposals: cfg.maxProposals,
      useLlm: cfg.useLlm,
      modelSource: cfg.modelSource,
      maxLlmSkills: cfg.maxLlmSkills,
    },
    skillCount: Array.isArray(input.skills) ? input.skills.length : 0,
    proposals,
  };
  await writeFile(proposalPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  const { applied, errors } = await applySkillsCuratorProposals(
    input.dataDir,
    input.skillsStore,
    proposals,
    applyMode,
  );

  if (applied.length && applyMode !== "propose") {
    try {
      await writeFile(
        proposalPath,
        `${JSON.stringify({
          ...envelope,
          status: "applied",
          appliedAt: new Date().toISOString(),
          applied,
          errors,
        }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      /* best effort */
    }
  }

  const llmCount = proposals.filter((p) => p.kind === "llm_patch").length;
  return {
    ok: true,
    via,
    proposals,
    applied,
    errors,
    proposalPath,
    fileName: basename(proposalPath),
    summary: `Skills curator: ${proposals.length} proposal(s) (${llmCount} LLM patch); applied ${applied.length} via ${via} (${applyMode})`,
  };
}

/**
 * @param {string} dataDir
 * @param {{ limit?: number }} [opts]
 */
export async function listSkillsCuratorProposals(dataDir, opts = {}) {
  const dir = skillsCuratorDir(dataDir);
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 40));
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = names
    .filter((n) => n.startsWith("proposal-") && n.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);

  const rows = [];
  for (const fileName of files) {
    try {
      const path = join(dir, fileName);
      const raw = JSON.parse(await readFile(path, "utf8"));
      const proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
      rows.push({
        fileName,
        path,
        via: raw.via ?? "heuristic",
        applyMode: raw.applyMode ?? "propose",
        status: raw.status ?? "pending",
        at: raw.at,
        applied: raw.applied,
        proposalCount: proposals.length,
        proposals,
      });
    } catch {
      /* skip corrupt */
    }
  }
  return rows;
}

/**
 * Apply a stored proposal envelope (safe disables only — never LLM patches).
 * @param {string} dataDir
 * @param {string} fileNameOrPath
 * @param {"apply_safe"} [applyMode]
 * @param {{ setEnabled: (id: string, enabled: boolean) => Promise<unknown> }} skillsStore
 */
export async function applyStoredSkillsCuratorProposal(
  dataDir,
  fileNameOrPath,
  applyMode,
  skillsStore,
) {
  const mode = "apply_safe";
  const fileName = basename(String(fileNameOrPath || ""));
  if (!fileName || !fileName.startsWith("proposal-") || !fileName.endsWith(".json") || fileName.includes("..")) {
    return { ok: false, error: "invalid_file", applied: [], errors: [] };
  }
  const path = join(skillsCuratorDir(dataDir), fileName);
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { ok: false, error: "not_found", applied: [], errors: [] };
  }
  const proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  const { applied, errors } = await applySkillsCuratorProposals(
    dataDir,
    skillsStore,
    proposals,
    mode,
  );
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        ...raw,
        status: applied.length ? "applied" : (raw.status ?? "pending"),
        appliedAt: new Date().toISOString(),
        applied: [...new Set([...(Array.isArray(raw.applied) ? raw.applied : []), ...applied])],
        errors,
      }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    /* best effort */
  }
  return {
    ok: true,
    fileName,
    applied,
    errors,
    summary: `Applied ${applied.length} skill curator action(s)`,
  };
}

/**
 * Apply a single proposal action interactively.
 * LLM patches: action "apply_patch" with suggestedContent/suggestedDescription.
 * @param {{
 *   setEnabled: (id: string, enabled: boolean) => Promise<unknown>,
 *   update?: (id: string, patch: { content?: string, description?: string }) => Promise<unknown>,
 * }} skillsStore
 * @param {{
 *   skillId: string,
 *   action: SkillsCuratorAction,
 *   suggestedContent?: string,
 *   suggestedDescription?: string,
 * }} proposal
 */
export async function applySingleSkillsProposal(skillsStore, proposal) {
  if (!proposal || typeof proposal.skillId !== "string") {
    return { ok: false, error: "invalid_proposal" };
  }
  if (proposal.action === "disable") {
    await skillsStore.setEnabled(proposal.skillId, false);
    return { ok: true, skillId: proposal.skillId, enabled: false };
  }
  if (proposal.action === "enable") {
    await skillsStore.setEnabled(proposal.skillId, true);
    return { ok: true, skillId: proposal.skillId, enabled: true };
  }
  // Only explicit apply_patch rewrites SKILL.md — never treat suggest_patch as a write.
  if (proposal.action === "suggest_patch") {
    return { ok: false, error: "use_apply_patch" };
  }
  if (proposal.action === "apply_patch") {
    if (typeof skillsStore.update !== "function") {
      return { ok: false, error: "update_unavailable" };
    }
    const content = typeof proposal.suggestedContent === "string" ? proposal.suggestedContent : "";
    const description = typeof proposal.suggestedDescription === "string"
      ? proposal.suggestedDescription
      : "";
    if (!content.trim() && !description.trim()) {
      return { ok: false, error: "empty_patch" };
    }
    const skill = await skillsStore.update(proposal.skillId, {
      ...(content.trim() ? { content } : {}),
      ...(description.trim() ? { description } : {}),
    });
    return { ok: true, skillId: proposal.skillId, patched: true, skill };
  }
  return { ok: false, error: "not_actionable" };
}
