/**
 * Evolution executor (step C) — pure planning helpers.
 *
 * Given an approved candidate, decide WHAT mutation (if any) a promotion should
 * perform, WITHOUT doing I/O. The gateway wires the chosen action to the real
 * SkillsStore / config mutation and captures prior state for rollback.
 *
 * Scope: only `skill` and `prompt-profile` targets have a safe, reversible write
 * path. `memory-ranking` (no boundary validation) and `reliability-hint` (no
 * mutation payload — observation only) are explicitly UNSUPPORTED and must be
 * failed honestly, never applied. A candidate whose target cannot be resolved to
 * a concrete mutation (e.g. a harvested `skill` draft with no content, or a
 * reserved profile id) is `reject_stale` — failed, never mutated blindly.
 */

import { BUILTIN_PROMPT_PROFILE_IDS } from "./team-defaults.js";

// PUBLIC_ID_RE is module-private in skills-store.js; mirror it (precedent:
// gateway.js's PROMPT_SKILL_ID_RE). Keep in sync with skills-store.js:38.
const SKILL_ID_RE = /^skill_[a-f0-9]{24}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_PROFILE_IDS = new Set(Object.values(BUILTIN_PROMPT_PROFILE_IDS));

/** Derive a valid, safe skill directory name from a free-form label. */
export function slugifySkillName(label) {
  const base = String(label ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!base || !SAFE_NAME_RE.test(base)) return "";
  return base;
}

/**
 * Classify what a promotion should do for this candidate.
 * @returns {{ action: "skill_update"|"skill_create"|"profile_update"|"profile_create"|"unsupported"|"reject_stale", reason?: string, skillId?: string, name?: string, content?: string, description?: string, profileId?: string, systemPrompt?: string }}
 */
export function classifyExecution(candidate, { existingProfileIds = [] } = {}) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const target = c.target && typeof c.target === "object" ? c.target : {};
  const proposal = c.proposal && typeof c.proposal === "object" ? c.proposal : {};
  const kind = target.kind;

  if (kind === "memory-ranking" || kind === "reliability-hint") {
    return { action: "unsupported", reason: "executor_kind_unsupported" };
  }

  if (kind === "skill") {
    const content = typeof proposal.content === "string" ? proposal.content : "";
    // An existing skill: target.id is a real skill id and we have new content.
    if (SKILL_ID_RE.test(String(target.id))) {
      if (!content.trim()) return { action: "reject_stale", reason: "executor_no_content" };
      return {
        action: "skill_update",
        skillId: target.id,
        content,
        ...(typeof proposal.description === "string" ? { description: proposal.description } : {}),
      };
    }
    // A new skill: needs both a usable name and content. Harvested drafts
    // (target.id = "playbook:<tool>", no content) fall through to reject_stale.
    const name = slugifySkillName(proposal.name || target.id);
    if (name && content.trim()) {
      return {
        action: "skill_create",
        name,
        content,
        ...(typeof proposal.description === "string" ? { description: proposal.description } : {}),
      };
    }
    return { action: "reject_stale", reason: "executor_target_stale" };
  }

  if (kind === "prompt-profile") {
    const profileId = String(target.id || "");
    const systemPrompt = typeof proposal.systemPrompt === "string" ? proposal.systemPrompt : "";
    // Never overwrite a built-in/reserved profile (e.g. kyrei-main, used by
    // every session by default).
    if (RESERVED_PROFILE_IDS.has(profileId)) {
      return { action: "reject_stale", reason: "executor_reserved_profile" };
    }
    if (!profileId || !systemPrompt.trim()) {
      return { action: "reject_stale", reason: "executor_target_stale" };
    }
    if (existingProfileIds.includes(profileId)) {
      return { action: "profile_update", profileId, systemPrompt };
    }
    return { action: "profile_create", profileId, systemPrompt, ...(typeof proposal.name === "string" ? { name: proposal.name } : {}) };
  }

  return { action: "unsupported", reason: "executor_kind_unsupported" };
}

/** Short (≤200c) receipt string recorded in the candidate's evidence.receipts. */
export function buildPromotionReceipt({ action, targetRef, execReceiptId }) {
  return `promoted:${action}:${String(targetRef ?? "").slice(0, 100)} ${String(execReceiptId ?? "").slice(0, 80)}`.slice(0, 200);
}

export { RESERVED_PROFILE_IDS, SKILL_ID_RE };
