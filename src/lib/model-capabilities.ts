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
}

export interface ExecutableModelParams {
  effort?: string;
  fast?: boolean;
}

/** Resolve a remembered UI preset into parameters the engine can execute. */
export function executableModelParams(
  protocol: ProviderProtocol | undefined,
  preset: ModelTuningPreset,
): ExecutableModelParams | undefined {
  if (!supportsModelTuning(protocol)) return undefined;
  if (preset.thinking === false) return { effort: "off" };
  // Fast is a latency-first mode, not an ornament on top of an explicit effort.
  // Omitting effort lets the engine resolve it to its supported minimal value.
  if (preset.fast) return { fast: true };
  if (preset.effort !== undefined) return { effort: preset.effort };
  if (preset.thinking === true) return { effort: "medium" };
  return undefined;
}
