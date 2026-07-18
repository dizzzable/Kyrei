import type { RuntimeSkill } from "../types.js";

const PROVENANCE_PRIORITY: Record<RuntimeSkill["provenance"], number> = {
  project: 0,
  global: 1,
  kiro: 2,
  custom: 3,
};

function normalized(value: string | undefined): string {
  return String(value ?? "").toLocaleLowerCase().trim();
}

function availabilityRank(skill: RuntimeSkill): number {
  if (skill.enabled === false) return 3;
  if (skill.availability === "incompatible" || skill.compatible === false) return 2;
  if (skill.availability === "unavailable") return 1;
  return 0;
}

export function catalogReasonCode(skill: RuntimeSkill | undefined): string {
  if (!skill) return "skill_not_found";
  if (skill.enabled === false) return skill.reasonCode || "skill_disabled";
  if (skill.availability === "incompatible" || skill.compatible === false) {
    return skill.reasonCode || "skill_incompatible";
  }
  if (skill.availability === "unavailable") return skill.reasonCode || "skill_unavailable";
  return "";
}

export function prefersCatalogSkill(left: RuntimeSkill, right: RuntimeSkill): boolean {
  const availability = availabilityRank(left) - availabilityRank(right);
  if (availability !== 0) return availability < 0;
  const usage = (right.usage ?? 0) - (left.usage ?? 0);
  if (usage !== 0) return usage < 0;
  const provenance = (PROVENANCE_PRIORITY[left.provenance] ?? 99) - (PROVENANCE_PRIORITY[right.provenance] ?? 99);
  if (provenance !== 0) return provenance < 0;
  const path = normalized(left.relativePath).localeCompare(normalized(right.relativePath));
  if (path !== 0) return path < 0;
  return normalized(left.id).localeCompare(normalized(right.id)) < 0;
}

export function dedupeCatalogForAuto(skills: readonly RuntimeSkill[]): RuntimeSkill[] {
  const byName = new Map<string, RuntimeSkill>();
  for (const skill of skills) {
    const key = normalized(skill.name);
    if (!key) continue;
    const current = byName.get(key);
    if (!current || prefersCatalogSkill(skill, current)) byName.set(key, skill);
  }
  return [...byName.values()].sort((left, right) =>
    (left.usage ?? 0) === (right.usage ?? 0)
      ? normalized(left.name).localeCompare(normalized(right.name)) || normalized(left.id).localeCompare(normalized(right.id))
      : (right.usage ?? 0) - (left.usage ?? 0));
}

export function searchCatalog(skills: readonly RuntimeSkill[], query: string): RuntimeSkill[] {
  const terms = normalized(query).split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  return skills
    .map((skill, index) => {
      const haystack: [string, string, string, string] = [
        normalized(skill.id),
        normalized(skill.name),
        normalized(skill.description),
        normalized(skill.reasonCode),
      ];
      let score = 0;
      for (const term of terms) {
        if (haystack[0] === term || haystack[1] === term) score += 16;
        else if (haystack[0].startsWith(term) || haystack[1].startsWith(term)) score += 8;
        else if (haystack[0].includes(term) || haystack[1].includes(term)) score += 4;
        else if (haystack[2].includes(term) || haystack[3].includes(term)) score += 1;
        else return null;
      }
      return { skill, index, score };
    })
    .filter((entry): entry is { skill: RuntimeSkill; index: number; score: number } => Boolean(entry))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.skill);
}

export function summarizeRequirements(skill: RuntimeSkill): string {
  const requirements = skill.metadata?.requirements;
  if (!requirements) return "";
  const parts: string[] = [];
  if (requirements.tools?.length) parts.push(`tools=${requirements.tools.join(",")}`);
  if (requirements.capabilities?.length) parts.push(`caps=${requirements.capabilities.join(",")}`);
  if (requirements.platforms?.length) parts.push(`platforms=${requirements.platforms.join(",")}`);
  if (requirements.network) parts.push("network");
  return parts.join(" ");
}

export function renderCatalogStatus(skill: RuntimeSkill): string {
  if (skill.enabled === false) return `disabled${catalogReasonCode(skill) ? ` (${catalogReasonCode(skill)})` : ""}`;
  if (skill.availability === "incompatible" || skill.compatible === false) {
    return `incompatible${catalogReasonCode(skill) ? ` (${catalogReasonCode(skill)})` : ""}`;
  }
  if (skill.availability === "unavailable") {
    return `unavailable${catalogReasonCode(skill) ? ` (${catalogReasonCode(skill)})` : ""}`;
  }
  return "ready";
}
