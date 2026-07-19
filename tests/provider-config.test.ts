import { describe, expect, it, vi } from "vitest";
import {
  collectProviderCredentialValues,
  defaultBaseURLForProtocol,
  deleteProviderAccountCredentials,
  getProviderAccountCredentials,
  getActiveProvider,
  normalizeGatewayConfig,
  normalizeProviderSecret,
  normalizeProviderSecrets,
  publicGatewayConfig,
  readyProviderAccounts,
  removeProvider,
  resolveProviderModel,
  selectProviderModel,
  setProviderAccountCredentials,
  upsertProvider,
  validateProviderAccountInput,
  validateProviderInput,
} from "../core/provider-config.js";
import { redactSensitiveText } from "../core/secret-redaction.js";

describe("provider registry config", () => {
  it("uses stable error codes instead of localized provider copy", () => {
    const single = normalizeGatewayConfig({});
    expect(() => removeProvider(single, single.providers[0].id)).toThrow("provider_final_profile");
    const { config: multiple } = upsertProvider(single, { name: "Second", models: [{ id: "model" }] });
    expect(() => removeProvider(multiple, "missing")).toThrow("provider_not_found");
    expect(() => selectProviderModel(single, "missing", "model")).toThrow("provider_unavailable");
    expect(() => selectProviderModel(single, single.activeProviderId, "x".repeat(513))).toThrow("provider_model_invalid");
  });

  it("migrates a legacy single provider and keeps its selected model", () => {
    const config = normalizeGatewayConfig({ provider: "http://127.0.0.1:11434/v1", apiKey: "legacy", model: "llama3" });
    expect(config.version).toBe(3);
    expect(config.providers).toHaveLength(1);
    expect(config.activeModelId).toBe("llama3");
    expect(config.providers[0]).toMatchObject({ protocol: "openai-chat", requiresApiKey: false });
    expect(config.providers[0]?.accountPool).toMatchObject({
      enabled: false,
      strategy: "balanced",
      sessionAffinity: true,
      members: [{ id: "primary" }],
    });
  });

  it("keeps the compatible reasoning dialect explicit and rejects unknown values", () => {
    const input = validateProviderInput({
      id: "glm",
      name: "Z.AI GLM",
      protocol: "openai-chat",
      reasoningTransport: "thinking-toggle",
      baseURL: "https://api.z.ai/api/paas/v4",
      models: [{ id: "glm-5" }],
      requiresApiKey: true,
    }, { creating: true });
    expect(input.reasoningTransport).toBe("thinking-toggle");

    const config = normalizeGatewayConfig({ providers: [input] });
    expect(config.providers[0]?.reasoningTransport).toBe("thinking-toggle");
    for (const reasoningTransport of [
      "zai-thinking-preserved",
      "kimi-thinking-preserved",
      "kimi-k3-reasoning-max",
    ] as const) {
      const explicit = validateProviderInput({ ...input, reasoningTransport }, { creating: true });
      expect(explicit.reasoningTransport).toBe(reasoningTransport);
      expect(normalizeGatewayConfig({ providers: [explicit] }).providers[0]?.reasoningTransport).toBe(reasoningTransport);
    }
    expect(() => validateProviderInput({ ...input, reasoningTransport: "model-name-guess" }, { creating: true }))
      .toThrow("provider_reasoning_transport_invalid");
  });

  it("persists only bounded public model capability metadata", () => {
    const config = normalizeGatewayConfig({
      providers: [{
        id: "metadata-provider",
        name: "Metadata provider",
        baseURL: "https://models.example/v1",
        models: [{
          id: "live-model",
          capabilities: {
            limits: { contextWindow: 128_000, maxOutput: 16_384, injected: 1 },
            modalities: { input: ["text", "image", "script"], output: ["text"] },
            features: { tools: true, reasoning: false, command: "calc.exe" },
            provenance: {
              source: "live-provider",
              confidence: "high",
              retrievedAt: 123,
              origin: {
                protocol: "openai-chat",
                baseURL: "https://models.example/v1",
                modelId: "live-model",
              },
              fields: {
                contextWindow: { source: "live-provider", confidence: "high" },
                tools: { source: "live-provider", confidence: "high" },
              },
            },
          },
        }],
      }],
    });

    expect(config.providers[0]?.models[0]).toEqual({
      id: "live-model",
      capabilities: {
        limits: { contextWindow: 128_000, maxOutput: 16_384 },
        modalities: { input: ["text", "image"], output: ["text"] },
        features: { tools: true, reasoning: false },
        provenance: expect.objectContaining({
          source: "live-provider",
          confidence: "high",
          retrievedAt: 123,
        }),
      },
    });
    // Injection must not survive model capability normalization (not whole-config
    // JSON: OOB team prompts legitimately use normal English words).
    expect(JSON.stringify(config.providers[0]?.models[0])).not.toMatch(/calc\.exe|injected/);
    expect(config.providers[0]?.models[0]).not.toHaveProperty("script");
    expect(config.providers[0]?.models[0]).not.toHaveProperty("command");
  });

  it("fills exact official metadata only for a canonical provider endpoint", () => {
    const official = normalizeGatewayConfig({
      providers: [{
        id: "openai",
        name: "OpenAI",
        protocol: "openai-responses",
        baseURL: "https://api.openai.com/v1",
        models: [{ id: "gpt-4o-mini" }],
      }],
    });
    expect(official.providers[0]?.models[0]?.capabilities?.limits).toEqual({
      contextWindow: 128_000,
      maxOutput: 16_384,
    });

    const proxy = normalizeGatewayConfig({
      providers: [{
        id: "xpiki",
        name: "Custom proxy",
        protocol: "openai-chat",
        baseURL: "https://api.xpiki.com/v1",
        models: [{ id: "gpt-4o-mini" }],
      }],
    });
    expect(proxy.providers[0]?.models[0]?.capabilities).toBeUndefined();

    const staleOfficialModel = official.providers[0]?.models[0];
    const editedToProxy = validateProviderInput({
      id: "xpiki",
      name: "Custom proxy",
      protocol: "openai-chat",
      baseURL: "https://api.xpiki.com/v1",
      models: [{ id: "gpt-4o-mini", capabilities: staleOfficialModel?.capabilities }],
      requiresApiKey: true,
    }, { creating: true });
    expect(editedToProxy.models[0]?.capabilities).toBeUndefined();
  });

  it("accepts live metadata only with a matching validated catalog origin", () => {
    const live = {
      limits: { contextWindow: 96_000, maxOutput: 12_000 },
      provenance: {
        source: "live-provider",
        confidence: "high",
        origin: {
          protocol: "openai-chat",
          baseURL: "https://catalog.example/v1",
          modelId: "catalog-model",
        },
        fields: {
          contextWindow: { source: "live-provider", confidence: "high" },
          maxOutput: { source: "live-provider", confidence: "high" },
        },
      },
    };
    const input = {
      id: "catalog",
      name: "Catalog",
      protocol: "openai-chat",
      baseURL: "https://catalog.example/v1",
      models: [{ id: "catalog-model", capabilities: live }],
      requiresApiKey: true,
    };

    const verifyLiveCapabilities = vi.fn(() => true);
    const accepted = validateProviderInput(input, { creating: true, verifyLiveCapabilities });
    expect(accepted.models[0]?.capabilities).toMatchObject({
      limits: { contextWindow: 96_000, maxOutput: 12_000 },
      provenance: {
        source: "live-provider",
        origin: {
          protocol: "openai-chat",
          baseURL: "https://catalog.example/v1",
          modelId: "catalog-model",
        },
      },
    });
    expect(verifyLiveCapabilities).toHaveBeenCalledWith({
      capabilities: {
        limits: { contextWindow: 96_000, maxOutput: 12_000 },
        provenance: {
          source: "live-provider",
          confidence: "high",
          fields: {
            contextWindow: { source: "live-provider", confidence: "high" },
            maxOutput: { source: "live-provider", confidence: "high" },
          },
        },
      },
      protocol: "openai-chat",
      baseURL: "https://catalog.example/v1",
      modelId: "catalog-model",
    });
    expect(normalizeGatewayConfig({ providers: [accepted] }).providers[0]?.models[0]?.capabilities).toMatchObject({
      limits: { contextWindow: 96_000, maxOutput: 12_000 },
      provenance: { source: "live-provider" },
    });

    const unbound = validateProviderInput({
      ...input,
      models: [{ id: "catalog-model", capabilities: { ...live, provenance: { ...live.provenance, origin: undefined } } }],
    }, { creating: true });
    expect(unbound.models[0]?.capabilities).toBeUndefined();

    const moved = validateProviderInput({ ...input, baseURL: "https://other.example/v1" }, { creating: true });
    expect(moved.models[0]?.capabilities).toBeUndefined();
  });

  it("rejects forged matching-origin live metadata when the discovery verifier denies it", () => {
    const forged = {
      limits: { contextWindow: 777_777, maxOutput: 77_777 },
      provenance: {
        source: "live-provider",
        confidence: "high",
        origin: {
          protocol: "openai-chat",
          baseURL: "https://forged.example/v1",
          modelId: "forged-model",
        },
        fields: {
          contextWindow: { source: "live-provider", confidence: "high" },
          maxOutput: { source: "live-provider", confidence: "high" },
        },
      },
    };
    const input = {
      id: "forged",
      name: "Forged",
      protocol: "openai-chat",
      baseURL: "https://forged.example/v1",
      models: [{ id: "forged-model", capabilities: forged }],
      requiresApiKey: true,
    };
    const deny = vi.fn(() => false);

    const rejected = validateProviderInput(input, { creating: true, verifyLiveCapabilities: deny });
    expect(deny).toHaveBeenCalledOnce();
    expect(rejected.models[0]?.capabilities).toBeUndefined();

    const accepted = validateProviderInput(input, { creating: true, verifyLiveCapabilities: () => true });
    expect(accepted.models[0]?.capabilities?.limits).toEqual({
      contextWindow: 777_777,
      maxOutput: 77_777,
    });

    const curatedOnly = validateProviderInput({
      ...input,
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      models: [{
        id: "gpt-4o-mini",
        capabilities: {
          ...forged,
          provenance: {
            ...forged.provenance,
            origin: {
              protocol: "openai-responses",
              baseURL: "https://api.openai.com/v1",
              modelId: "gpt-4o-mini",
            },
          },
        },
      }],
    }, { creating: true, verifyLiveCapabilities: () => false });
    expect(curatedOnly.models[0]?.capabilities).toMatchObject({
      limits: { contextWindow: 128_000, maxOutput: 16_384 },
      provenance: { source: "curated" },
    });
  });

  it("migrates extra account secrets separately and redacts every credential", () => {
    const config = normalizeGatewayConfig({
      providers: [{
        id: "pooled",
        name: "Pooled",
        baseURL: "https://api.example.test/v1",
        models: [{ id: "alpha" }],
        accountPool: {
          enabled: true,
          members: [
            { id: "primary", name: "Primary" },
            { id: "backup", name: "Backup", weight: 2, maxConcurrency: 3 },
          ],
        },
      }],
    });
    let secrets = normalizeProviderSecrets({
      providers: { pooled: { apiKey: "primary-secret" } },
      accounts: { pooled: { backup: { apiKey: "backup-secret" }, primary: { apiKey: "ignored" } } },
    });

    expect(secrets.version).toBe(3);
    expect(getProviderAccountCredentials(secrets, "pooled", "primary").apiKey).toBe("primary-secret");
    expect(getProviderAccountCredentials(secrets, "pooled", "backup").apiKey).toBe("backup-secret");
    expect(readyProviderAccounts(config.providers[0], secrets).map((account) => account.id)).toEqual(["primary", "backup"]);
    const publicConfig = publicGatewayConfig(config, secrets);
    expect(publicConfig.providers[0]?.accountPool.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "backup", hasStoredCredentials: true, ready: true, weight: 2, maxConcurrency: 3 }),
    ]));
    expect(JSON.stringify(publicConfig)).not.toMatch(/primary-secret|backup-secret|ignored/);

    secrets = setProviderAccountCredentials(secrets, "pooled", "third", { apiKey: "third-secret" });
    expect(getProviderAccountCredentials(secrets, "pooled", "third").apiKey).toBe("third-secret");
    secrets = deleteProviderAccountCredentials(secrets, "pooled", "third");
    expect(getProviderAccountCredentials(secrets, "pooled", "third")).toEqual({});
  });

  it("persists Kiro organization policy separately and treats its keys as runtime secrets", () => {
    const marker = "kiro-organization-test-secret";
    const config = normalizeGatewayConfig({
      kiroOrganization: {
        enabled: true,
        accounts: [{
          id: "build-team",
          name: "Build team",
          modelIds: ["auto"],
          projectIds: ["kyrei"],
        }],
      },
    });
    const secrets = normalizeProviderSecrets({
      kiroOrganization: {
        version: 1,
        accounts: {
          "build-team": { kind: "api-key", apiKey: marker },
        },
      },
    });

    expect(config.kiroOrganization).toMatchObject({
      version: 1,
      enabled: true,
      accounts: [{ id: "build-team", maxConcurrency: 1 }],
    });
    expect(secrets.kiroOrganization.accounts["build-team"]).toEqual({ kind: "api-key", apiKey: marker });
    expect(collectProviderCredentialValues(secrets, config.providers)).toContain(marker);
    expect(JSON.stringify(publicGatewayConfig(config, secrets))).not.toContain(marker);
    expect(redactSensitiveText(`failure ${marker}`, collectProviderCredentialValues(secrets, config.providers)))
      .toBe("failure [REDACTED]");
  });

  it("keeps account model-rule intent, intersects stale IDs, and strictly validates mutations", () => {
    const config = normalizeGatewayConfig({
      providers: [{
        id: "scoped",
        name: "Scoped",
        baseURL: "https://api.example.test/v1",
        models: [{ id: "alpha" }, { id: "beta" }],
        accountPool: {
          enabled: true,
          members: [
            { id: "primary", name: "Primary", modelIds: ["alpha", "stale", "alpha"] },
            { id: "unrestricted", name: "Unrestricted" },
            { id: "denied", name: "Denied", modelIds: [] },
          ],
        },
      }],
    });
    const members = config.providers[0]!.accountPool.members;
    expect(members.find((member) => member.id === "primary")?.modelIds).toEqual(["alpha"]);
    expect(Object.hasOwn(members.find((member) => member.id === "unrestricted")!, "modelIds")).toBe(false);
    expect(members.find((member) => member.id === "denied")?.modelIds).toEqual([]);
    expect(publicGatewayConfig(config, normalizeProviderSecrets({})).providers[0]?.accountPool.members)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "primary", modelIds: ["alpha"] }),
        expect.objectContaining({ id: "denied", modelIds: [] }),
      ]));

    expect(validateProviderAccountInput({
      id: "backup",
      name: "Backup",
      modelIds: ["beta", "beta"],
    }, {
      accountId: "backup",
      providerModels: config.providers[0]!.models,
    })).toMatchObject({ modelIds: ["beta"] });
    expect(() => validateProviderAccountInput({
      id: "backup",
      name: "Backup",
      modelIds: ["unknown"],
    }, {
      accountId: "backup",
      providerModels: config.providers[0]!.models,
    })).toThrow("provider_account_models_invalid");
    expect(() => validateProviderAccountInput({
      id: "backup",
      name: "Backup",
      modelIds: "alpha",
    }, {
      accountId: "backup",
      providerModels: config.providers[0]!.models,
    })).toThrow("provider_account_models_invalid");
    expect(() => validateProviderAccountInput({
      id: "backup",
      name: "Backup",
      modelIds: Array.from({ length: 2_001 }, () => "alpha"),
    }, {
      accountId: "backup",
      providerModels: config.providers[0]!.models,
    })).toThrow("provider_account_models_invalid");
    const cleared = validateProviderAccountInput({
      id: "backup",
      name: "Backup",
      modelIds: null,
    }, {
      accountId: "backup",
      providerModels: config.providers[0]!.models,
    });
    expect(Object.hasOwn(cleared, "modelIds")).toBe(false);
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

  it("collects short credentials and client identity without redacting cloud routing metadata", () => {
    const values = collectProviderCredentialValues({
      providers: {
        cloud: {
          apiKey: "k",
          accessKeyId: "id2",
          secretAccessKey: "s3cr3t",
          sessionToken: "tok",
          privateKey: "pk",
          region: "r",
          project: "proj",
          location: "loc",
          clientEmail: "me@x",
        },
      },
    }, [{
      headers: {
        "X-Auth-Token": "hdr",
        "X-Region": "north",
      },
    }]);

    expect(new Set(values)).toEqual(new Set(["k", "id2", "s3cr3t", "tok", "pk", "me@x", "hdr"]));
    const redacted = redactSensitiveText(
      "k id2 s3cr3t tok pk hdr | r proj loc me@x north",
      values,
    );
    expect(redacted).toBe(
      "[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] | r proj loc [REDACTED] north",
    );
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

  it("strictly rejects custom header names that can carry credentials", () => {
    expect(() => validateProviderInput({
      id: "secret-header",
      name: "Secret header",
      protocol: "openai-chat",
      baseURL: "https://example.test/v1",
      models: [{ id: "model" }],
      headers: { "X-Auth-Token": "opaque-value" },
    }, { creating: true })).toThrow("provider_header_secret_forbidden");
  });

  it("validates an explicit stable id separately from the display name", () => {
    const input = validateProviderInput({
      id: "xpiki",
      displayName: "Xpiki",
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      models: [{ id: "chat-model", name: "Chat model" }],
      enabled: true,
      requiresApiKey: true,
    }, { creating: true });
    expect(input).toMatchObject({ id: "xpiki", name: "Xpiki" });

    let config = normalizeGatewayConfig({});
    ({ config } = upsertProvider(config, input, input.id));
    ({ config } = upsertProvider(config, { ...input, name: "Xpiki Cloud" }, input.id));
    expect(config.providers.find((provider) => provider.id === "xpiki")?.name).toBe("Xpiki Cloud");
    expect(() => validateProviderInput({ ...input, id: "Not valid!" }, { creating: true })).toThrow("provider_id_invalid");
    expect(() => validateProviderInput({ ...input, id: "other" }, { providerId: "xpiki" })).toThrow("provider_id_immutable");
    expect(() => validateProviderInput({ ...input, baseURL: "file:///tmp/models" }, { creating: true })).toThrow("provider_base_url_invalid");
    expect(() => validateProviderInput({ ...input, models: [] }, { creating: true })).toThrow("provider_models_required");
  });

  it("preserves explicit enabled/manual-model intent for custom providers independent of discovery outcome", () => {
    const input = validateProviderInput({
      id: "xpiki",
      displayName: "Xpiki",
      protocol: "openai-chat",
      baseURL: "http://93.184.216.34:8080/v1",
      models: [{ id: "manual-alpha", name: "Manual alpha" }, { id: "manual-beta" }],
      enabled: false,
      requiresApiKey: true,
      allowInsecureHttp: true,
    }, { creating: true });
    expect(input).toMatchObject({
      id: "xpiki",
      enabled: false,
      allowInsecureHttp: true,
      models: [
        { id: "manual-alpha", name: "Manual alpha" },
        { id: "manual-beta" },
      ],
    });

    const config = normalizeGatewayConfig({
      providers: [input],
      activeProviderId: "xpiki",
      activeModelId: "manual-beta",
    });
    expect(config.providers[0]).toMatchObject({
      id: "xpiki",
      enabled: false,
      allowInsecureHttp: true,
      models: [
        { id: "manual-alpha", name: "Manual alpha" },
        { id: "manual-beta" },
      ],
    });
    expect(config.activeProviderId).toBe("");
    expect(config.activeModelId).toBe("");
  });

  it("normalizes and reconciles the provider-scoped worker assignment", () => {
    let config = normalizeGatewayConfig({});
    ({ config } = upsertProvider(config, {
      id: "worker",
      name: "Worker",
      protocol: "openai-chat",
      baseURL: "https://worker.example/v1",
      models: [{ id: "worker-model" }],
    }, "worker"));
    config = normalizeGatewayConfig({
      ...config,
      modelAssignments: { worker: { providerId: "worker", modelId: "worker-model" } },
    });
    expect(config.modelAssignments.worker).toEqual({ providerId: "worker", modelId: "worker-model" });
    expect(publicGatewayConfig(config, normalizeProviderSecrets({})).modelAssignments.worker).toEqual({
      providerId: "worker",
      modelId: "worker-model",
    });

    config = removeProvider(config, "worker");
    expect(config.modelAssignments.worker).toBeUndefined();
  });

  it("persists coding-mode role model assignments (plan/build/polish/deepreep)", () => {
    let config = normalizeGatewayConfig({
      providers: [
        {
          id: "main",
          name: "Main",
          protocol: "openai-chat",
          baseURL: "https://main.example/v1",
          models: [{ id: "main-model" }, { id: "plan-model" }, { id: "build-model" }],
        },
      ],
      activeProviderId: "main",
      activeModelId: "main-model",
      modelAssignments: {
        plan: { providerId: "main", modelId: "plan-model" },
        build: { providerId: "main", modelId: "build-model" },
        polish: { providerId: "main", modelId: "main-model" },
        deepreep: { providerId: "main", modelId: "plan-model" },
      },
    });
    expect(config.modelAssignments).toMatchObject({
      plan: { providerId: "main", modelId: "plan-model" },
      build: { providerId: "main", modelId: "build-model" },
      polish: { providerId: "main", modelId: "main-model" },
      deepreep: { providerId: "main", modelId: "plan-model" },
    });
    // Round-trip must not drop role keys (regression: only worker+fallbacks survived).
    config = normalizeGatewayConfig(config);
    expect(config.modelAssignments.plan).toEqual({ providerId: "main", modelId: "plan-model" });
    expect(config.modelAssignments.build).toEqual({ providerId: "main", modelId: "build-model" });
  });

  it("normalizes ordered provider-scoped fallback assignments without confusing model slashes", () => {
    const config = normalizeGatewayConfig({
      providers: [
        {
          id: "primary",
          name: "Primary",
          protocol: "openai-chat",
          baseURL: "https://primary.example/v1",
          models: [{ id: "main" }],
        },
        {
          id: "backup",
          name: "Backup",
          protocol: "anthropic-messages",
          baseURL: "https://backup.example/v1",
          models: [{ id: "vendor/model-with/slashes" }, { id: "second" }],
        },
      ],
      activeProviderId: "primary",
      activeModelId: "main",
      modelAssignments: {
        fallbacks: [
          { providerId: "backup", modelId: "vendor/model-with/slashes" },
          { providerId: "backup", modelId: "second" },
          { providerId: "backup", modelId: "vendor/model-with/slashes" },
          { providerId: "missing", modelId: "ignored" },
        ],
      },
    });

    expect(config.modelAssignments.fallbacks).toEqual([
      { providerId: "backup", modelId: "vendor/model-with/slashes" },
      { providerId: "backup", modelId: "second" },
    ]);
    expect(publicGatewayConfig(config, normalizeProviderSecrets({})).modelAssignments.fallbacks)
      .toEqual(config.modelAssignments.fallbacks);

    expect(removeProvider(config, "backup").modelAssignments.fallbacks).toEqual([]);
  });

  it("resolves a session target strictly or falls back to the configured default", () => {
    const config = normalizeGatewayConfig({ provider: "https://default.example/v1", model: "default-model" });
    expect(resolveProviderModel(config, config.activeProviderId, "default-model")).toMatchObject({
      provider: { id: config.activeProviderId },
      model: { id: "default-model" },
    });
    expect(() => resolveProviderModel(config, "missing", "missing")).toThrow("provider_unavailable");
    expect(resolveProviderModel(config, "missing", "missing", { fallbackToDefault: true })).toMatchObject({
      provider: { id: config.activeProviderId },
      model: { id: "default-model" },
    });
  });

  it("never resolves a disabled provider as the default fallback", () => {
    const config = normalizeGatewayConfig({
      providers: [{
        id: "disabled",
        name: "Disabled",
        protocol: "openai-chat",
        baseURL: "https://disabled.example/v1",
        models: [{ id: "model" }],
        enabled: false,
      }],
      activeProviderId: "disabled",
      activeModelId: "model",
    });
    expect(getActiveProvider(config)).toBeNull();
    expect(() => resolveProviderModel(config, "missing", "missing", { fallbackToDefault: true })).toThrow("provider_unavailable");
  });

  it("keeps the selected default model when an unrelated provider is removed", () => {
    let config = normalizeGatewayConfig({
      providers: [
        {
          id: "active",
          name: "Active",
          protocol: "openai-chat",
          baseURL: "https://active.example/v1",
          models: [{ id: "first" }, { id: "chosen" }],
        },
        {
          id: "other",
          name: "Other",
          protocol: "openai-chat",
          baseURL: "https://other.example/v1",
          models: [{ id: "other" }],
        },
      ],
      activeProviderId: "active",
      activeModelId: "chosen",
    });
    config = removeProvider(config, "other");
    expect(config).toMatchObject({ activeProviderId: "active", activeModelId: "chosen" });
  });
});
