import { describe, expect, it } from "vitest";

import type { ProviderProfile, ProviderTemplate } from "@/lib/types";
import {
  canUseStoredCredentialsForDiscovery,
  createDraftFromProfile,
  createDraftFromTemplate,
  draftDiscoveryInput,
  draftProviderInput,
  mergeDiscoveredModels,
  orderedProviderTemplates,
  providerDraftCredentials,
  providerDraftHasCredentialInput,
  providerDraftModels,
  providerSupportsModelDiscovery,
} from "./provider-draft";

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
  it("advertises automatic discovery only for implemented OpenAI-compatible transports", () => {
    expect(providerSupportsModelDiscovery("openai-chat")).toBe(true);
    expect(providerSupportsModelDiscovery("openai-responses")).toBe(true);
    expect(providerSupportsModelDiscovery("anthropic-messages")).toBe(false);
    expect(providerSupportsModelDiscovery("google-generative-ai")).toBe(false);
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

  it("creates a custom draft without performing any persistence", () => {
    const custom: ProviderTemplate = { id: "custom", name: "Custom provider", custom: true };
    const draft = createDraftFromTemplate(custom, false);

    expect(draft).toMatchObject({ id: "", name: "", baseURL: "", useAsDefault: false, idLocked: false });
    expect(providerDraftModels(draft)).toEqual([]);
  });

  it("keeps benchmark-network permission scoped to the discovery request", () => {
    const draft = createDraftFromProfile(configured, false);
    draft.allowBenchmarkNetwork = true;

    expect(draftDiscoveryInput(draft)).toMatchObject({ allowBenchmarkNetwork: true });
    expect(draftProviderInput(draft)).not.toHaveProperty("allowBenchmarkNetwork");
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
