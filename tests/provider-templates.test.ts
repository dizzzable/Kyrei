import { describe, expect, it } from "vitest";
import {
  PROVIDER_TEMPLATES,
  PROVIDER_TEMPLATES_VERSION,
} from "../core/provider-templates.js";
import { SUPPORTED_PROVIDER_PROTOCOLS } from "../core/provider-config.js";

describe("provider templates", () => {
  it("ships the approved provider catalogue with Custom last", () => {
    const ids = PROVIDER_TEMPLATES.map((template) => template.id);
    expect(ids).toEqual(expect.arrayContaining([
      "openai",
      "anthropic",
      "gemini",
      "bedrock",
      "vertex",
      "openrouter",
      "deepseek",
      "alibaba",
      "alibaba-coding-plan",
      "arcee",
      "azure-foundry",
      "gmi",
      "huggingface",
      "kilocode",
      "kimi",
      "kimi-cn",
      "minimax",
      "minimax-cn",
      "novita",
      "nvidia",
      "ollama-cloud",
      "opencode-zen",
      "opencode-go",
      "stepfun",
      "xiaomi",
      "zai",
      "xai",
      "ollama",
      "lm-studio",
      "custom",
    ]));
    expect(ids.at(-1)).toBe("custom");
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROVIDER_TEMPLATES_VERSION).toBeGreaterThan(0);
  });

  it("contains only supported, secret-free public metadata", () => {
    const forbidden = /nous|hermes|oauth|copilot|acp/i;
    for (const template of PROVIDER_TEMPLATES) {
      expect(template.id).not.toMatch(forbidden);
      expect(template.name).not.toMatch(forbidden);
      expect(SUPPORTED_PROVIDER_PROTOCOLS).toContain(template.protocol);
      expect(JSON.stringify(template)).not.toMatch(/"apiKey"\s*:|secret|credential|authorization/i);
      if (template.baseURL) {
        const url = new URL(template.baseURL);
        expect(["http:", "https:"]).toContain(url.protocol);
        expect(url.username || url.password || url.search || url.hash).toBe("");
      } else {
        expect(template.requiresBaseURL).toBe(true);
      }
    }
  });
});
