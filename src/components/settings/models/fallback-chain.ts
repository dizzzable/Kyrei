import type { ModelRef, ProviderProfile } from "@/lib/types";
import { isProviderReady } from "./model-options";

export const MAX_FALLBACK_MODELS = 16;

export function normalizeFallbackModels(
  values: readonly ModelRef[],
  providers: readonly ProviderProfile[],
): ModelRef[] {
  const ready = new Map(
    providers.filter(isProviderReady).map((provider) => [provider.id, new Set(provider.models.map((model) => model.id))]),
  );
  const seen = new Set<string>();
  const normalized: ModelRef[] = [];
  for (const value of values) {
    if (!ready.get(value.providerId)?.has(value.modelId)) continue;
    const key = `${value.providerId}\0${value.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ providerId: value.providerId, modelId: value.modelId });
    if (normalized.length === MAX_FALLBACK_MODELS) break;
  }
  return normalized;
}

export function nextFallbackModel(
  values: readonly ModelRef[],
  providers: readonly ProviderProfile[],
  main: ModelRef,
): ModelRef | undefined {
  const used = new Set(values.map((value) => `${value.providerId}\0${value.modelId}`));
  used.add(`${main.providerId}\0${main.modelId}`);
  for (const provider of providers) {
    if (!isProviderReady(provider)) continue;
    for (const model of provider.models) {
      if (!used.has(`${provider.id}\0${model.id}`)) return { providerId: provider.id, modelId: model.id };
    }
  }
  return undefined;
}

export function moveFallbackModel(values: readonly ModelRef[], from: number, to: number): ModelRef[] {
  if (from < 0 || from >= values.length || to < 0 || to >= values.length || from === to) return [...values];
  const next = values.map((value) => ({ ...value }));
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(to, 0, moved);
  return next;
}
