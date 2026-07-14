import type { ModelCapabilityMetadata, ModelModality } from "@/lib/types";
import type { ModelPreset } from "@/store/model-presets";

export interface EffectiveModelLimits {
  contextWindow?: number;
  maxOutput?: number;
  contextSource: "override" | "detected" | "unknown";
  outputSource: "override" | "detected" | "unknown";
}

/** Manual values are explicit user policy; auto-detection remains unchanged. */
export function effectiveModelLimits(
  metadata: ModelCapabilityMetadata | undefined,
  preset: Pick<ModelPreset, "contextWindowOverride" | "maxOutputOverride">,
): EffectiveModelLimits {
  const contextWindow = preset.contextWindowOverride ?? metadata?.limits?.contextWindow;
  const maxOutput = preset.maxOutputOverride ?? metadata?.limits?.maxOutput;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    contextSource: preset.contextWindowOverride !== undefined
      ? "override"
      : metadata?.limits?.contextWindow !== undefined
        ? "detected"
        : "unknown",
    outputSource: preset.maxOutputOverride !== undefined
      ? "override"
      : metadata?.limits?.maxOutput !== undefined
        ? "detected"
        : "unknown",
  };
}

export function orderedModalities(values: readonly ModelModality[] | undefined): ModelModality[] {
  const present = new Set(values ?? []);
  return (["text", "image", "audio", "video", "file"] as const).filter((value) => present.has(value));
}

export function compactTokenCount(value: number | undefined, locale: "en" | "ru"): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000 && value % 1_000 === 0) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 1_000_000)}M`;
  }
  if (value >= 1_000 && value % 1_000 === 0) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1_000)}k`;
  }
  return new Intl.NumberFormat(locale).format(value);
}
