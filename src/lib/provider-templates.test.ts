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
    expect(providerTemplateDescriptionKey({ ...templates[0], descriptionKey: "server.injected.raw.key" })).toBeUndefined();
    expect(providerTemplateDescriptionKey({ ...templates[0], descriptionKey: "common.cancel" })).toBeUndefined();
  });

  it("keeps Custom last while compacting a large catalogue", () => {
    const result = selectVisibleProviderTemplates(templates, { limit: 2 });

    expect(result.items.map((template) => template.id)).toEqual(["openai", "anthropic", "custom"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("searches names, protocols, and localised descriptions without hiding Custom", () => {
    const result = selectVisibleProviderTemplates(templates, {
      query: "local models",
      description: (template) => template.id === "ollama" ? "Run local models" : "",
    });

    expect(result.items.map((template) => template.id)).toEqual(["ollama", "custom"]);
    expect(result.hiddenCount).toBe(0);
  });
});
