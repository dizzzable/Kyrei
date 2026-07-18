import { describe, expect, it } from "vitest";

import type { ModelCapabilityMetadata, ProviderProfile, ProviderTemplate } from "@/lib/types";
import {
  canUseStoredCredentialsForDiscovery,
  createDraftFromProfile,
  createDraftFromTemplate,
  shouldDefaultUseAsDefault,
  draftDiscoveryInput,
  draftProviderInput,
  mergeDiscoveredModels,
  orderedProviderTemplates,
  providerDraftCredentials,
  providerDraftHasCredentialInput,
  providerDraftModels,
  providerSupportsModelDiscovery,
  updateProviderDraftEndpoint,
} from "./provider-draft";

const liveCapabilities: ModelCapabilityMetadata = {
  limits: { contextWindow: 128_000, maxOutput: 16_384 },
  modalities: { input: ["text", "image"], output: ["text"] },
  features: { tools: true, streaming: true },
  provenance: {
    source: "live-provider",
    confidence: "high",
    retrievedAt: 123,
    fields: {
      contextWindow: { source: "live-provider", confidence: "high" },
      maxOutput: { source: "live-provider", confidence: "high" },
      inputModalities: { source: "live-provider", confidence: "high" },
      outputModalities: { source: "live-provider", confidence: "high" },
      tools: { source: "live-provider", confidence: "high" },
      streaming: { source: "live-provider", confidence: "high" },
    },
  },
};

const configured: ProviderProfile = {
  id: "xpiki",
  name: "Xpiki",
  protocol: "openai-chat",
  baseURL: "https://api.example.com/v1",
  models: [{ id: "chat-model", name: "Chat model" }],
  enabled: true,
  requiresApiKey: true,
  hasKey: true,
};

describe("provider setup drafts", () => {
  it("advertises automatic discovery only for implemented read-only catalog transports", () => {
    expect(providerSupportsModelDiscovery("openai-chat")).toBe(true);
    expect(providerSupportsModelDiscovery("openai-responses")).toBe(true);
    expect(providerSupportsModelDiscovery("anthropic-messages")).toBe(true);
    expect(providerSupportsModelDiscovery("google-generative-ai")).toBe(true);
    expect(providerSupportsModelDiscovery("amazon-bedrock")).toBe(false);
    expect(providerSupportsModelDiscovery("google-vertex")).toBe(false);
  });

  it("creates an isolated edit draft without mutating the configured profile", () => {
    const draft = createDraftFromProfile(configured, false);
    draft.name = "Renamed";
    draft.selectedModelIds.add("worker-model");

    expect(configured.name).toBe("Xpiki");
    expect(configured.models).toEqual([{ id: "chat-model", name: "Chat model" }]);
    expect(draft.idLocked).toBe(true);
    expect(draft.useAsDefault).toBe(false);
  });

  it("keeps Custom last while preserving the curated template order", () => {
    const templates: ProviderTemplate[] = [
      { id: "custom", name: "Custom provider", custom: true },
      { id: "openai", name: "OpenAI", protocol: "openai-responses", baseURL: "https://api.openai.com/v1", requiresApiKey: true },
      { id: "ollama", name: "Ollama", protocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1", requiresApiKey: false },
    ];

    expect(orderedProviderTemplates(templates).map((template) => template.id)).toEqual(["openai", "ollama", "custom"]);
  });

  it("merges discovery results without dropping manually selected models", () => {
    const draft = createDraftFromProfile(configured, false);
    draft.manualModel = "manual-model";
    const withManual = mergeDiscoveredModels(draft, [{ id: "chat-model" }, { id: "new-model", name: "New model" }]);

    expect(providerDraftModels(withManual)).toEqual([
      { id: "chat-model", name: "Chat model" },
      { id: "new-model", name: "New model" },
      { id: "manual-model" },
    ]);
  });

  it("binds fresh metadata to the current endpoint and clears stale metadata when a row is now unknown", () => {
    const draft = createDraftFromProfile({
      ...configured,
      models: [{ id: "chat-model", name: "Chat model", capabilities: liveCapabilities }],
    }, false);
    const refreshed = mergeDiscoveredModels(draft, [{ id: "chat-model", capabilities: liveCapabilities }]);
    expect((refreshed.availableModels[0]?.capabilities?.provenance as ModelCapabilityMetadata["provenance"] & {
      origin?: unknown;
    }).origin).toEqual({
      protocol: "openai-chat",
      baseURL: "https://api.example.com/v1",
      modelId: "chat-model",
    });

    const unknownNow = mergeDiscoveredModels(refreshed, [{ id: "chat-model" }]);
    expect(unknownNow.availableModels[0]).toEqual({ id: "chat-model", name: "Chat model" });
  });

  it("invalidates learned capabilities whenever protocol or base URL changes", () => {
    const draft = createDraftFromProfile({
      ...configured,
      models: [{ id: "gpt-4o-mini", capabilities: liveCapabilities }],
    }, false);
    const proxy = updateProviderDraftEndpoint(draft, { baseURL: "https://api.xpiki.com/v1" });
    expect(proxy.hasStoredCredentials).toBe(false);
    expect(proxy.availableModels[0]?.capabilities).toBeUndefined();
    expect(mergeDiscoveredModels(proxy, [{ id: "gpt-4o-mini" }]).availableModels[0]?.capabilities).toBeUndefined();

    const anthropic = updateProviderDraftEndpoint(draft, { protocol: "anthropic-messages" });
    expect(anthropic.availableModels[0]?.capabilities).toBeUndefined();
  });

  it("keeps the typed endpoint free of secondary network trust switches", () => {
    const draft = createDraftFromProfile({
      ...configured,
      baseURL: "http://93.184.216.34:8080/v1",
    }, false);

    expect(draftDiscoveryInput(draft)).toMatchObject({
      baseURL: "http://93.184.216.34:8080/v1",
    });
    expect(draftDiscoveryInput(draft)).not.toHaveProperty("allowInsecureHttp");
    expect(draftDiscoveryInput(draft)).not.toHaveProperty("allowBenchmarkNetwork");
    expect(draftProviderInput(draft)).not.toHaveProperty("allowInsecureHttp");
  });

  it("creates a custom draft without performing any persistence", () => {
    const custom: ProviderTemplate = { id: "custom", name: "Custom provider", custom: true };
    const draft = createDraftFromTemplate(custom, false);

    expect(draft).toMatchObject({ id: "", name: "", baseURL: "", useAsDefault: false, idLocked: false });
    expect(providerDraftModels(draft)).toEqual([]);
  });

  it("defaults use-as-default only when no ready provider exists (first-run)", () => {
    expect(shouldDefaultUseAsDefault([
      { enabled: true, requiresApiKey: true, hasKey: false, hasStoredCredentials: false },
    ])).toBe(true);
    expect(shouldDefaultUseAsDefault([
      { enabled: true, requiresApiKey: true, hasKey: true, hasStoredCredentials: true },
    ])).toBe(false);
    expect(shouldDefaultUseAsDefault([
      { enabled: true, requiresApiKey: false, hasKey: false, hasStoredCredentials: false },
    ])).toBe(false);
  });

  it("keeps stored specialised credentials when every write-only field is blank", () => {
    const draft = createDraftFromProfile({
      ...configured,
      protocol: "amazon-bedrock",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      hasStoredCredentials: true,
    }, false);

    expect(providerDraftHasCredentialInput(draft)).toBe(false);
    expect(providerDraftCredentials(draft)).toEqual({ region: "" });

    draft.accessKeyId = "replacement-access-key";
    expect(providerDraftHasCredentialInput(draft)).toBe(true);
  });

  it("recognises partial Vertex replacement credentials so validation cannot be skipped", () => {
    const draft = createDraftFromProfile({
      ...configured,
      protocol: "google-vertex",
      baseURL: "https://aiplatform.googleapis.com",
      hasStoredCredentials: true,
    }, false);
    draft.privateKey = "partial replacement";

    expect(providerDraftHasCredentialInput(draft)).toBe(true);
    expect(providerDraftCredentials(draft)).toMatchObject({ privateKey: "partial replacement" });
  });

  it("reuses stored discovery credentials only while the authentication contract is unchanged", () => {
    const draft = createDraftFromProfile(configured, false);
    expect(canUseStoredCredentialsForDiscovery(configured, draft)).toBe(true);

    expect(canUseStoredCredentialsForDiscovery(configured, { ...draft, requiresApiKey: false })).toBe(false);
    expect(canUseStoredCredentialsForDiscovery(configured, { ...draft, protocol: "openai-responses" })).toBe(false);
    expect(canUseStoredCredentialsForDiscovery(configured, { ...draft, baseURL: "https://other.example/v1" })).toBe(false);
    expect(canUseStoredCredentialsForDiscovery(configured, { ...draft, apiKey: "replacement" })).toBe(false);
  });
});
