import { describe, expect, it } from "vitest";
import {
  defaultBaseURLForProtocol,
  getActiveProvider,
  normalizeGatewayConfig,
  normalizeProviderSecret,
  normalizeProviderSecrets,
  publicGatewayConfig,
  removeProvider,
  selectProviderModel,
  upsertProvider,
} from "../core/provider-config.js";

describe("provider registry config", () => {
  it("uses stable error codes instead of localized provider copy", () => {
    const single = normalizeGatewayConfig({});
    expect(() => removeProvider(single, single.providers[0].id)).toThrow("provider_final_profile");
    const { config: multiple } = upsertProvider(single, { name: "Second", models: [{ id: "model" }] });
    expect(() => removeProvider(multiple, "missing")).toThrow("provider_not_found");
    expect(() => selectProviderModel(single, "missing", "model")).toThrow("provider_unavailable");
  });

  it("migrates a legacy single provider and keeps its selected model", () => {
    const config = normalizeGatewayConfig({ provider: "http://127.0.0.1:11434/v1", apiKey: "legacy", model: "llama3" });
    expect(config.version).toBe(2);
    expect(config.providers).toHaveLength(1);
    expect(config.activeModelId).toBe("llama3");
    expect(config.providers[0]).toMatchObject({ protocol: "openai-chat", requiresApiKey: false });
  });

  it("accepts built-in native transport protocols and protocol-specific base URL defaults", () => {
    const config = normalizeGatewayConfig({
      providers: [{
        id: "anthropic",
        name: "Anthropic",
        protocol: "anthropic-messages",
        baseURL: "notaurl",
        models: [{ id: "claude-3-5-sonnet-20241022" }],
      }],
    });
    expect(config.providers[0]).toMatchObject({
      protocol: "anthropic-messages",
      baseURL: defaultBaseURLForProtocol("anthropic-messages"),
    });
  });

  it("normalizes Google, Bedrock, and Vertex transport URLs", () => {
    for (const protocol of ["google-generative-ai", "amazon-bedrock", "google-vertex"]) {
      const config = normalizeGatewayConfig({
        providers: [{ id: protocol, protocol, baseURL: "invalid", models: [{ id: "model" }] }],
      });
      expect(config.providers[0]).toMatchObject({ protocol, baseURL: defaultBaseURLForProtocol(protocol) });
    }
  });

  it("keeps credentials outside the public config response", () => {
    const config = normalizeGatewayConfig({ provider: "https://api.example.test/v1", model: "alpha" });
    const secrets = normalizeProviderSecrets({ providers: { [config.activeProviderId]: { apiKey: "secret-value" } } });
    const publicConfig = publicGatewayConfig(config, secrets);
    expect(publicConfig.hasKey).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toContain("secret-value");
    expect(publicConfig.providers[0]?.hasKey).toBe(true);
  });

  it("allowlists multi-field cloud credentials and never returns them publicly", () => {
    const normalized = normalizeProviderSecret({
      region: "us-east-1",
      accessKeyId: "access-id",
      secretAccessKey: "secret-value",
      sessionToken: "session-value",
      arbitrary: "must-not-persist",
    });
    expect(normalized).toEqual({
      region: "us-east-1",
      accessKeyId: "access-id",
      secretAccessKey: "secret-value",
      sessionToken: "session-value",
    });

    const config = normalizeGatewayConfig({
      providers: [{
        id: "bedrock",
        protocol: "amazon-bedrock",
        models: [{ id: "anthropic.claude" }],
      }],
    });
    const secrets = normalizeProviderSecrets({ providers: { bedrock: normalized } });
    const publicConfig = publicGatewayConfig(config, secrets);
    expect(publicConfig.providers[0]?.hasKey).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toMatch(/secret-value|access-id|session-value/);
  });

  it("does not persist credentials in endpoint URLs or custom headers", () => {
    const config = normalizeGatewayConfig({
      providers: [{
        id: "custom",
        name: "Custom",
        baseURL: "https://name:password@example.test/v1",
        headers: {
          Authorization: "Bearer secret-value",
          "X-API-Key": "secret-value",
          "X-Goog-Api-Key": "secret-value",
          "X-Amz-Security-Token": "secret-value",
          "HTTP-Referer": "https://kyrei.local",
        },
        models: [{ id: "alpha" }],
      }, {
        id: "query-secret",
        name: "Query secret",
        baseURL: "https://example.test/v1?api_key=secret-value#fragment",
        models: [{ id: "beta" }],
      }],
    });
    const provider = config.providers[0]!;
    expect(provider.baseURL).toBe("https://api.openai.com/v1");
    expect(provider.headers).toEqual({ "HTTP-Referer": "https://kyrei.local" });
    expect(config.providers[1]?.baseURL).toBe("https://api.openai.com/v1");
    expect(JSON.stringify(publicGatewayConfig(config, normalizeProviderSecrets({})))).not.toContain("secret-value");
  });

  it("supports provider-scoped duplicate model ids and active selection", () => {
    let config = normalizeGatewayConfig({ provider: "https://one.example/v1", model: "shared" });
    ({ config } = upsertProvider(config, { name: "Two", baseURL: "https://two.example/v1", models: [{ id: "shared" }] }));
    const second = config.providers.find((provider) => provider.name === "Two")!;
    config = selectProviderModel(config, second.id, "shared");
    expect(getActiveProvider(config)?.id).toBe(second.id);
    expect(config.activeModelId).toBe("shared");
  });

  it("does not leave selection dangling when an active provider is removed", () => {
    let config = normalizeGatewayConfig({});
    ({ config } = upsertProvider(config, { name: "Second", baseURL: "https://second.example/v1", models: [{ id: "second" }] }));
    const second = config.providers.find((provider) => provider.name === "Second")!;
    config = selectProviderModel(config, second.id, "second");
    config = removeProvider(config, second.id);
    expect(config.activeProviderId).not.toBe(second.id);
    expect(getActiveProvider(config)).not.toBeNull();
  });
});
