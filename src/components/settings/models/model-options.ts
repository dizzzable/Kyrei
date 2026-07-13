import type { ModelRef, ProviderModel, ProviderProfile } from "@/lib/types";

export function isProviderReady(provider: ProviderProfile): boolean {
  return provider.enabled && (!provider.requiresApiKey || provider.hasKey);
}

/** Keep model pickers truthful: only executable providers may be selected. */
export function selectableModelProviders(
  providers: readonly ProviderProfile[],
  includeProviderId?: string,
): ProviderProfile[] {
  return providers.filter((provider) => isProviderReady(provider) || provider.id === includeProviderId);
}

export function modelOptionsForProvider(providers: readonly ProviderProfile[], providerId: string): ProviderModel[] {
  return providers.find((provider) => provider.id === providerId)?.models.map((model) => ({ ...model })) ?? [];
}

export function isSameModelRef(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

export function resolveModelAssignment(assignment: ModelRef | undefined, main: ModelRef): { ref: ModelRef; inherited: boolean } {
  return assignment ? { ref: { ...assignment }, inherited: false } : { ref: { ...main }, inherited: true };
}
