import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider, setLang } from "@/i18n";
import type { AppConfig } from "@/lib/types";
import { ModelSettings } from "./ModelSettings";

const config: AppConfig = {
  provider: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  workspace: "",
  hasKey: true,
  activeProviderId: "openai",
  activeProviderName: "OpenAI",
  activeModelId: "gpt-4o-mini",
  providers: [{
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseURL: "https://api.openai.com/v1",
    models: [{
      id: "gpt-4o-mini",
      capabilities: {
        limits: { contextWindow: 128_000, maxOutput: 16_384 },
        modalities: { input: ["text", "image"], output: ["text"] },
        features: { tools: true, reasoning: false, streaming: true },
        provenance: { source: "curated", confidence: "high", fields: {} },
      },
    }],
    enabled: true,
    requiresApiKey: true,
    hasKey: true,
  }],
  orchestration: { defaultMode: "single", activeProfileId: "", profiles: [] },
  pipelines: { version: 1, generation: 0, definitions: [] },
  engine: {},
};

describe("ModelSettings capability integration", () => {
  it("shows the selected model's truthful metadata and manual limit controls", () => {
    setLang("en");
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ModelSettings, { config, onSaved: vi.fn() }),
    ));

    expect(html).toContain("Context and capabilities");
    expect(html).toContain("Detected: 128k");
    expect(html).toContain("Detected: 16,384");
    expect(html).toContain("Official registry · High confidence");
    expect(html).not.toContain("32k");
  });

  it("keeps reasoning controls available for a selected custom OpenAI-compatible endpoint", () => {
    setLang("en");
    const customConfig: AppConfig = {
      ...config,
      provider: "https://gateway.example.test/v1",
      activeProviderId: "custom",
      activeProviderName: "Custom gateway",
      providers: [{
        ...config.providers[0]!,
        id: "custom",
        name: "Custom gateway",
        protocol: "openai-chat",
        baseURL: "https://gateway.example.test/v1",
        models: [{
          id: "reasoning-model",
          capabilities: {
            provenance: { source: "live-provider", confidence: "high", fields: {} },
            // Some compatible `/models` endpoints omit this field even when
            // they accept `reasoning_effort` on chat-completions.
            features: { reasoning: false },
          },
        }],
      }],
      model: "reasoning-model",
      activeModelId: "reasoning-model",
    };
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ModelSettings, { config: customConfig, onSaved: vi.fn() }),
    ));

    expect(html).not.toContain('id="model-tuning-unavailable"');
  });

  it("does not expose misleading Fast and effort controls for fixed-reasoning Kimi K3", () => {
    setLang("en");
    const kimiConfig: AppConfig = {
      ...config,
      provider: "https://api.moonshot.cn/v1",
      activeProviderId: "kimi",
      activeProviderName: "Kimi",
      providers: [{
        ...config.providers[0]!,
        id: "kimi",
        name: "Kimi",
        protocol: "openai-chat",
        reasoningTransport: "kimi-k3-reasoning-max",
        baseURL: "https://api.moonshot.cn/v1",
        models: [{ id: "kimi-k3" }],
      }],
      model: "kimi-k3",
      activeModelId: "kimi-k3",
    };
    const html = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ModelSettings, { config: kimiConfig, onSaved: vi.fn() }),
    ));

    expect(html).toContain("always uses its maximum reasoning level");
    expect(html).toContain('id="model-tuning-unavailable"');
  });
});
