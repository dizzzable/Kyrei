import type {
  ModelCapabilityMetadata,
  ProviderCredentialsInput,
  ProviderDiscoveryInput,
  ProviderModel,
  ProviderProfile,
  ProviderProtocol,
  ProviderTemplate,
} from "@/lib/types";
import { sortProviderTemplates } from "@/lib/provider-templates";

export interface ProviderDraft {
  editingId?: string;
  templateId?: string;
  id: string;
  idLocked: boolean;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  /** Never persisted; scopes the reserved-network exception to one discovery request. */
  allowBenchmarkNetwork: boolean;
  requiresApiKey: boolean;
  hasStoredCredentials: boolean;
  apiKey: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  project: string;
  location: string;
  clientEmail: string;
  privateKey: string;
  availableModels: ProviderModel[];
  selectedModelIds: Set<string>;
  manualModel: string;
  useAsDefault: boolean;
}

interface ModelCapabilityOrigin {
  protocol: ProviderProtocol;
  baseURL: string;
  modelId: string;
}

function canonicalCapabilityBaseURL(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function withoutModelCapabilities(model: ProviderModel): ProviderModel {
  const { capabilities: _capabilities, ...publicModel } = model;
  return publicModel;
}

function bindDiscoveredCapabilities(draft: ProviderDraft, model: ProviderModel): ProviderModel {
  if (!model.capabilities) return withoutModelCapabilities(model);
  const baseURL = canonicalCapabilityBaseURL(draft.baseURL);
  if (!baseURL) return withoutModelCapabilities(model);
  const origin: ModelCapabilityOrigin = { protocol: draft.protocol, baseURL, modelId: model.id };
  const provenance: ModelCapabilityMetadata["provenance"] = {
    ...model.capabilities.provenance,
    origin,
  };
  return { ...model, capabilities: { ...model.capabilities, provenance } };
}

/** Endpoint changes invalidate every fact learned from the previous catalog. */
export function updateProviderDraftEndpoint(
  draft: ProviderDraft,
  patch: Partial<Pick<ProviderDraft, "protocol" | "baseURL" | "hasStoredCredentials">>,
): ProviderDraft {
  const protocol = patch.protocol ?? draft.protocol;
  const baseURL = patch.baseURL ?? draft.baseURL;
  const endpointChanged = protocol !== draft.protocol || baseURL !== draft.baseURL;
  return {
    ...draft,
    ...patch,
    allowBenchmarkNetwork: false,
    ...(endpointChanged
      ? {
          hasStoredCredentials: false,
          availableModels: draft.availableModels.map(withoutModelCapabilities),
        }
      : {}),
  };
}

/** The reserved-network exception is a one-attempt capability, never dialog state. */
export function consumeBenchmarkNetworkPermission(draft: ProviderDraft): ProviderDraft {
  return draft.allowBenchmarkNetwork ? { ...draft, allowBenchmarkNetwork: false } : draft;
}

export function providerSupportsModelDiscovery(protocol: ProviderProtocol): boolean {
  return protocol === "openai-chat"
    || protocol === "openai-responses"
    || protocol === "anthropic-messages"
    || protocol === "google-generative-ai";
}

function copyModels(models: readonly ProviderModel[] | undefined): ProviderModel[] {
  return (models ?? []).map((model) => ({ ...model }));
}

/** First-run: default "Use as default" when no credential-ready provider exists. */
export function shouldDefaultUseAsDefault(
  providers: readonly Pick<ProviderProfile, "enabled" | "requiresApiKey" | "hasKey" | "hasStoredCredentials">[],
): boolean {
  return !providers.some((provider) => (
    provider.enabled !== false
    && (provider.requiresApiKey === false
      || provider.hasKey === true
      || provider.hasStoredCredentials === true)
  ));
}

export function createDraftFromProfile(profile: ProviderProfile, useAsDefault: boolean): ProviderDraft {
  const models = copyModels(profile.models);
  return {
    editingId: profile.id,
    id: profile.id,
    idLocked: true,
    name: profile.name,
    protocol: profile.protocol,
    baseURL: profile.baseURL,
    allowBenchmarkNetwork: false,
    requiresApiKey: profile.requiresApiKey,
    hasStoredCredentials: Boolean(profile.hasStoredCredentials || profile.hasKey),
    apiKey: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    project: "",
    location: "",
    clientEmail: "",
    privateKey: "",
    availableModels: models,
    selectedModelIds: new Set(models.map((model) => model.id)),
    manualModel: "",
    useAsDefault,
  };
}

export function createDraftFromTemplate(template: ProviderTemplate, useAsDefault: boolean): ProviderDraft {
  const custom = template.custom === true;
  const models = copyModels(template.models);
  return {
    templateId: template.id,
    id: custom ? "" : template.id,
    idLocked: false,
    name: custom ? "" : template.name,
    protocol: template.protocol ?? "openai-chat",
    baseURL: template.baseURL ?? "",
    allowBenchmarkNetwork: false,
    requiresApiKey: template.requiresApiKey !== false,
    hasStoredCredentials: false,
    apiKey: "",
    region: template.protocol === "amazon-bedrock" ? "us-east-1" : "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    project: "",
    location: template.protocol === "google-vertex" ? "us-central1" : "",
    clientEmail: "",
    privateKey: "",
    availableModels: models,
    selectedModelIds: new Set(models.map((model) => model.id)),
    manualModel: "",
    useAsDefault,
  };
}

export function orderedProviderTemplates(templates: readonly ProviderTemplate[]): ProviderTemplate[] {
  return sortProviderTemplates(templates);
}

export function providerDraftModels(draft: ProviderDraft): ProviderModel[] {
  const selected = draft.availableModels.filter((model) => draft.selectedModelIds.has(model.id));
  const manual = draft.manualModel
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const result: ProviderModel[] = [];
  for (const model of [...selected, ...manual.map((id) => ({ id }))]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push({ ...model });
  }
  return result;
}

export function providerDraftCredentials(draft: ProviderDraft): ProviderCredentialsInput {
  if (draft.protocol === "amazon-bedrock") {
    return {
      region: draft.region.trim(),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(draft.accessKeyId.trim() ? { accessKeyId: draft.accessKeyId.trim() } : {}),
      ...(draft.secretAccessKey.trim() ? { secretAccessKey: draft.secretAccessKey.trim() } : {}),
      ...(draft.sessionToken.trim() ? { sessionToken: draft.sessionToken.trim() } : {}),
    };
  }
  if (draft.protocol === "google-vertex") {
    return {
      project: draft.project.trim(),
      location: draft.location.trim(),
      clientEmail: draft.clientEmail.trim(),
      privateKey: draft.privateKey.trim(),
    };
  }
  return { apiKey: draft.apiKey.trim() };
}

/** Credentials are write-only; any entered field means the full replacement must be validated. */
export function providerDraftHasCredentialInput(draft: ProviderDraft): boolean {
  const credentials = providerDraftCredentials(draft);
  return Object.values(credentials).some((value) => Boolean(value?.trim()));
}

/** Saved credentials are valid for discovery only for the unchanged auth endpoint. */
export function canUseStoredCredentialsForDiscovery(
  original: ProviderProfile,
  draft: ProviderDraft,
): boolean {
  return !providerDraftHasCredentialInput(draft)
    && original.protocol === draft.protocol
    && original.baseURL === draft.baseURL.trim()
    && original.requiresApiKey === draft.requiresApiKey;
}

export function mergeDiscoveredModels(draft: ProviderDraft, discovered: readonly ProviderModel[]): ProviderDraft {
  const byId = new Map(draft.availableModels.map((model) => [model.id, { ...model }]));
  const selected = new Set(draft.selectedModelIds);
  for (const model of discovered) {
    const previous = byId.get(model.id);
    // A fresh catalog row without metadata means "unknown now". Do not retain
    // limits learned from an earlier endpoint or an older catalog response.
    const previousWithoutCapabilities = previous ? withoutModelCapabilities(previous) : undefined;
    byId.set(model.id, {
      ...previousWithoutCapabilities,
      ...bindDiscoveredCapabilities(draft, model),
    });
    selected.add(model.id);
  }
  return { ...draft, availableModels: [...byId.values()], selectedModelIds: selected };
}

export function draftDiscoveryInput(draft: ProviderDraft): ProviderDiscoveryInput {
  return {
    ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
    name: draft.name.trim(),
    protocol: draft.protocol,
    baseURL: draft.baseURL.trim(),
    requiresApiKey: draft.requiresApiKey,
    ...(draft.allowBenchmarkNetwork ? { allowBenchmarkNetwork: true } : {}),
    models: providerDraftModels(draft),
  };
}

export function draftProviderInput(draft: ProviderDraft): Partial<ProviderProfile> {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    protocol: draft.protocol,
    baseURL: draft.baseURL.trim(),
    requiresApiKey: draft.requiresApiKey,
    enabled: true,
    models: providerDraftModels(draft),
  };
}
