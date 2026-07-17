import { describe, expect, it } from "vitest";

import type { ProviderTemplate } from "@/lib/types";
import {
  providerTemplateDescriptionKey,
  selectVisibleProviderTemplates,
} from "./provider-templates";

const templates: ProviderTemplate[] = [
  { id: "openai", name: "OpenAI", protocol: "openai-responses", descriptionKey: "settings.providers.templates.openai.description" },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", descriptionKey: "settings.providers.templates.anthropic.description" },
  { id: "ollama", name: "Ollama", protocol: "openai-chat", descriptionKey: "settings.providers.templates.ollama.description" },
  { id: "custom", name: "Custom provider", custom: true },
];

describe("provider template presentation", () => {
  it("accepts only translation keys present in Kyrei's locale catalogue", () => {
    expect(providerTemplateDescriptionKey(templates[0])).toBe("settings.providers.templates.openai.description");
    // Invalid keys fall back to openaiCompatible for chat protocols (safe generic blurb).
    expect(providerTemplateDescriptionKey({ ...templates[0], descriptionKey: "server.injected.raw.key" }))
      .toBe("settings.providers.templates.openaiCompatible.description");
    expect(providerTemplateDescriptionKey({ ...templates[0], descriptionKey: "common.cancel" }))
      .toBe("settings.providers.templates.openaiCompatible.description");
    expect(providerTemplateDescriptionKey({
      id: "x",
      name: "X",
      protocol: "anthropic-messages",
      descriptionKey: "server.injected.raw.key",
    })).toBeUndefined();
  });

  it("pins Custom first so any missing vendor is one click away", () => {
    const result = selectVisibleProviderTemplates(templates, { limit: 2 });

    expect(result.items.map((template) => template.id)).toEqual(["custom", "openai", "anthropic"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("searches names, protocols, and localised descriptions without hiding Custom", () => {
    const result = selectVisibleProviderTemplates(templates, {
      query: "local models",
      description: (template) => template.id === "ollama" ? "Run local models" : "",
    });

    expect(result.items.map((template) => template.id)).toEqual(["custom", "ollama"]);
    expect(result.hiddenCount).toBe(0);
  });

  it("falls back to openaiCompatible blurb for catalog entries without per-vendor i18n", () => {
    expect(providerTemplateDescriptionKey({
      id: "groq",
      name: "Groq",
      protocol: "openai-chat",
      descriptionKey: "settings.providers.templates.openaiCompatible.description",
    })).toBe("settings.providers.templates.openaiCompatible.description");
  });
});
