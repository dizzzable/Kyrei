import type { ModelCapabilityMetadata, ProviderProtocol } from "@/lib/types";

const MODEL_TUNING_PROTOCOLS: ReadonlySet<ProviderProtocol> = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "amazon-bedrock",
  // The official ChatGPT/Codex connector serializes these controls through
  // app-server thread start/resume rather than the AI SDK, but it is still a
  // real executable tuning surface.
  "codex-app-server",
]);

/**
 * A user-selected OpenAI-compatible endpoint may support `reasoning_effort`
 * while exposing an incomplete `/models` capability record. The official API
 * keeps its catalog as the source of truth; every other endpoint is an
 * explicit operator choice and may expose the compatible field directly.
 */
export function allowsConfiguredEndpointTuning(profile: {
  protocol?: ProviderProtocol;
  baseURL?: string;
} | undefined): boolean {
  if (profile?.protocol !== "openai-chat") return false;
  const baseURL = profile.baseURL?.trim();
  if (!baseURL) return false;
  try {
    return new URL(baseURL).hostname.toLowerCase() !== "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * UI reasoning controls are available only when both layers agree:
 * - the installed protocol adapter can serialize the setting
 * - discovered model metadata, when present, does not explicitly disable it
 */
export function supportsModelTuning(
  protocol: ProviderProtocol | undefined,
  capabilities?: ModelCapabilityMetadata,
  options?: { allowConfiguredEndpointTuning?: boolean },
): boolean {
  if (protocol === undefined || !MODEL_TUNING_PROTOCOLS.has(protocol)) return false;
  // A user-managed OpenAI-compatible endpoint can document a reasoning field
  // even when its model catalog reports stale or incomplete capability data.
  // The endpoint selection is an explicit user decision; never infer it from
  // a model name.
  if (options?.allowConfiguredEndpointTuning && protocol === "openai-chat") return true;
  return capabilities?.features?.reasoning !== false;
}

interface ModelTuningPreset {
  thinking?: boolean;
  effort?: string;
  fast?: boolean;
  contextWindowOverride?: number;
  maxOutputOverride?: number;
}

export interface ExecutableModelParams {
  effort?: string;
  fast?: boolean;
  contextWindowOverride?: number;
  maxOutputOverride?: number;
}

export const MODEL_LIMIT_OVERRIDE_BOUNDS = Object.freeze({
  contextWindow: { min: 256, max: 100_000_000 },
  maxOutput: { min: 1, max: 10_000_000 },
});

export function normalizeModelLimitOverride(
  value: number | string | null | undefined,
  kind: keyof typeof MODEL_LIMIT_OVERRIDE_BOUNDS,
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  const bounds = MODEL_LIMIT_OVERRIDE_BOUNDS[kind];
  return Number.isSafeInteger(parsed) && parsed >= bounds.min && parsed <= bounds.max ? parsed : undefined;
}

/** Resolve a remembered UI preset into parameters the engine can execute. */
export function executableModelParams(
  protocol: ProviderProtocol | undefined,
  preset: ModelTuningPreset,
): ExecutableModelParams | undefined {
  const contextWindowOverride = normalizeModelLimitOverride(preset.contextWindowOverride, "contextWindow");
  const maxOutputOverride = normalizeModelLimitOverride(preset.maxOutputOverride, "maxOutput");
  const result: ExecutableModelParams = {
    ...(contextWindowOverride !== undefined ? { contextWindowOverride } : {}),
    ...(maxOutputOverride !== undefined ? { maxOutputOverride } : {}),
  };
  if (supportsModelTuning(protocol)) {
    if (preset.thinking === false) result.effort = "off";
    // Fast is a latency-first mode, not an ornament on top of an explicit effort.
    // Omitting effort lets the engine resolve it to its supported minimal value.
    else if (preset.fast) result.fast = true;
    else if (preset.effort !== undefined) result.effort = preset.effort;
    else if (preset.thinking === true) result.effort = "medium";
  }
  return Object.keys(result).length ? result : undefined;
}
