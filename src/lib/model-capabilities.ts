import type { ProviderProtocol } from "@/lib/types";

const MODEL_TUNING_PROTOCOLS: ReadonlySet<ProviderProtocol> = new Set([
  "openai-chat",
  "openai-responses",
]);

/**
 * The engine currently serializes Reasoning/Fast only for OpenAI request
 * shapes. Keep renderer controls and outbound modelParams aligned with that
 * executable contract.
 */
export function supportsModelTuning(protocol: ProviderProtocol | undefined): boolean {
  return protocol !== undefined && MODEL_TUNING_PROTOCOLS.has(protocol);
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
