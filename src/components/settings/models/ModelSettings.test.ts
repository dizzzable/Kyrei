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
});
