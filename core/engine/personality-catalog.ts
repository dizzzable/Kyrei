/**
 * Built-in assistant personality presets (Hermes agent.personalities analogue).
 * Effective style is resolved for the system prompt; free-text `personality`
 * remains for custom tone. Labels are i18n keys on the UI side.
 */

export interface PersonalityPreset {
  id: string;
  /** Stable English body injected into the system prompt. */
  body: string;
}

/** Catalog curated for coding-agent use (not meme-heavy Hermes extras by default). */
export const BUILTIN_PERSONALITY_PRESETS: readonly PersonalityPreset[] = [
  {
    id: "helpful",
    body: "You are a helpful, friendly AI assistant. Be clear, accurate, and collaborative.",
  },
  {
    id: "concise",
    body: "You are a concise assistant. Keep responses brief and to the point; prefer bullets and short patches.",
  },
  {
    id: "technical",
    body: "You are a technical expert. Provide detailed, accurate technical information with precise identifiers and trade-offs.",
  },
  {
    id: "teacher",
    body: "You are a patient teacher. Explain concepts clearly with examples, then give the concrete next step.",
  },
  {
    id: "reviewer",
    body: "You are a careful code reviewer. Prioritize correctness, security, and maintainability; call out risks explicitly.",
  },
  {
    id: "implementer",
    body: "You are a pragmatic implementer. Prefer small, verifiable changes, run checks when possible, and avoid drive-by refactors.",
  },
] as const;

export const PERSONALITY_PRESET_IDS = BUILTIN_PERSONALITY_PRESETS.map((p) => p.id);

export function getPersonalityPreset(id: string | undefined | null): PersonalityPreset | undefined {
  if (!id || id === "custom" || id === "none" || id === "") return undefined;
  return BUILTIN_PERSONALITY_PRESETS.find((p) => p.id === id);
}

/**
 * Resolve the style string for the system prompt.
 * - known preset id → preset body (unless custom text was intentionally preferred)
 * - custom / empty id → free-text personality
 */
export function resolvePersonalityText(opts: {
  personalityPresetId?: string;
  personality?: string;
}): string {
  const custom = typeof opts.personality === "string" ? opts.personality.trim() : "";
  const id = typeof opts.personalityPresetId === "string" ? opts.personalityPresetId.trim() : "";
  if (!id || id === "custom" || id === "none") return custom;
  const preset = getPersonalityPreset(id);
  if (!preset) return custom;
  // If user overrode text after picking a preset, prefer the free-text field when it
  // no longer matches the catalog body (Settings keeps id in sync when selecting chips).
  if (custom && custom !== preset.body) return custom;
  return preset.body;
}

/** Match free text back to a preset id when possible (import / migration). */
export function matchPersonalityPresetId(text: string): string {
  const t = text.trim();
  if (!t) return "none";
  const hit = BUILTIN_PERSONALITY_PRESETS.find((p) => p.body === t);
  return hit ? hit.id : "custom";
}
