/**
 * Per-`provider::model` UI preset (effort/fast), remembered across sessions.
 * Client-only storage. Supported OpenAI request protocols wire these through
 * the gateway to the engine (`modelParams` → `reasoning_effort`); other
 * protocols keep the controls unavailable instead of pretending to apply them.
 */

import { useMemo } from "react";
import { persistentJsonAtom, useAtom } from "@/store/atom";

export interface ModelPreset {
  /** Master reasoning toggle ("Thinking"). Undefined = provider default. */
  thinking?: boolean;
  /** Reasoning effort level when thinking is on. */
  effort?: string;
  /** Latency-first variant. */
  fast?: boolean;
}

const STORAGE_KEY = "kyrei.model-presets.v1";

export const $modelPresets = persistentJsonAtom<Record<string, ModelPreset>>(STORAGE_KEY, {});

export const modelPresetKey = (provider: string, model: string): string => `${provider}::${model}`;

export function getModelPreset(provider: string, model: string): ModelPreset {
  return $modelPresets.get()[modelPresetKey(provider, model)] ?? {};
}

export function setModelPreset(provider: string, model: string, patch: ModelPreset): void {
  const key = modelPresetKey(provider, model);
  const current = $modelPresets.get();
  $modelPresets.set({ ...current, [key]: { ...current[key], ...patch } });
}

/** React hook for a single model's preset. */
export function useModelPreset(provider: string, model: string): ModelPreset {
  // Select the whole map (referentially stable) and derive the slice locally —
  // routing the provider/model args through the shared getSnapshot cache would
  // freeze a stale slice when the map is unchanged but the key changes.
  const all = useAtom($modelPresets);
  const key = modelPresetKey(provider, model);
  return useMemo(() => all[key] ?? {}, [all, key]);
}
