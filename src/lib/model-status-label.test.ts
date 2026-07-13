import { describe, it, expect } from "vitest";
import {
  formatModelStatusLabel,
  modelDisplayParts,
  modelBaseId,
  reasoningEffortLabel,
  currentPickerSelection,
} from "@/lib/model-status-label";
import { createTranslator } from "@/i18n/translate";
import { enChat } from "@/i18n/locales/en/chat";
import { ruChat } from "@/i18n/locales/ru/chat";

const en = createTranslator(enChat, "en");
const ru = createTranslator(ruChat, "ru");

describe("reasoningEffortLabel", () => {
  it("maps known efforts to short labels", () => {
    expect(reasoningEffortLabel("none", en)).toBe("Off");
    expect(reasoningEffortLabel("minimal", en)).toBe("Min");
    expect(reasoningEffortLabel("low", en)).toBe("Low");
    expect(reasoningEffortLabel("medium", en)).toBe("Med");
    expect(reasoningEffortLabel("high", en)).toBe("High");
    expect(reasoningEffortLabel("xhigh", en)).toBe("Max");
  });

  it("is case-insensitive and trims", () => {
    expect(reasoningEffortLabel("  HIGH  ", en)).toBe("High");
  });

  it("returns empty for empty input", () => {
    expect(reasoningEffortLabel("", en)).toBe("");
    expect(reasoningEffortLabel("   ", en)).toBe("");
  });

  it("passes through unknown efforts unchanged", () => {
    expect(reasoningEffortLabel("turbo", en)).toBe("turbo");
  });
});

describe("modelBaseId", () => {
  it("strips the provider prefix", () => {
    expect(modelBaseId("openai/gpt-5")).toBe("gpt-5");
    expect(modelBaseId("anthropic/claude-opus-4.8")).toBe("claude-opus-4.8");
  });

  it("keeps ids without a slash", () => {
    expect(modelBaseId("gpt-5")).toBe("gpt-5");
  });
});

describe("modelDisplayParts", () => {
  it("extracts the -fast variant tag", () => {
    expect(modelDisplayParts("anthropic/claude-opus-4.8-fast", en)).toEqual({
      name: "Opus 4.8",
      tag: "Fast",
    });
  });

  it("extracts the -thinking variant tag", () => {
    expect(modelDisplayParts("claude-sonnet-4-thinking", en)).toEqual({
      name: "Sonnet 4",
      tag: "Thinking",
    });
  });

  it("prettifies gpt- prefix", () => {
    expect(modelDisplayParts("openai/gpt-5", en).name).toBe("GPT-5");
  });

  it("prettifies claude- prefix", () => {
    expect(modelDisplayParts("claude-opus-4.8", en).name).toBe("Opus 4.8");
  });

  it("prettifies gemini- prefix", () => {
    expect(modelDisplayParts("gemini-2.5-pro", en).name).toBe("Gemini 2.5 pro");
  });

  it("drops a trailing date-pin", () => {
    expect(modelDisplayParts("claude-opus-4-20251101", en).name).toBe("Opus 4");
  });

  it("falls back to a placeholder for empty input", () => {
    expect(modelDisplayParts("", en)).toEqual({ name: "No model", tag: "" });
  });

  it("localizes semantic model state without changing model ids", () => {
    expect(modelDisplayParts("anthropic/claude-opus-4.8-fast", ru)).toEqual({
      name: "Opus 4.8",
      tag: "Быстро",
    });
  });
});

describe("formatModelStatusLabel", () => {
  it("combines name and effort", () => {
    expect(formatModelStatusLabel("openai/gpt-5", en, { reasoningEffort: "high" })).toBe(
      "GPT-5 · High"
    );
  });

  it("defaults effort to Med when unset", () => {
    expect(formatModelStatusLabel("openai/gpt-5", en)).toBe("GPT-5 · Med");
  });

  it("maps xhigh effort to Max", () => {
    expect(formatModelStatusLabel("openai/gpt-5", en, { reasoningEffort: "xhigh" })).toBe(
      "GPT-5 · Max"
    );
  });

  it("shows Fast when fastMode is on", () => {
    expect(formatModelStatusLabel("openai/gpt-5", en, { fastMode: true })).toBe(
      "GPT-5 · Fast Med"
    );
  });

  it("shows Fast for a -fast model variant", () => {
    expect(formatModelStatusLabel("anthropic/claude-opus-4.8-fast", en)).toBe(
      "Opus 4.8 · Fast Med"
    );
  });

  it("returns just the name for empty model", () => {
    expect(formatModelStatusLabel("", en)).toBe("No model");
  });
});

describe("currentPickerSelection", () => {
  it("prefers server options during a live session", () => {
    expect(
      currentPickerSelection(true, { model: "gpt-5", provider: "openai" }, {
        model: "claude", provider: "anthropic",
      })
    ).toEqual({ model: "claude", provider: "anthropic" });
  });

  it("prefers the sticky store pick pre-session", () => {
    expect(
      currentPickerSelection(false, { model: "gpt-5", provider: "openai" }, {
        model: "claude", provider: "anthropic",
      })
    ).toEqual({ model: "gpt-5", provider: "openai" });
  });

  it("falls back to empty strings when nothing is set", () => {
    expect(currentPickerSelection(false, { model: "", provider: "" })).toEqual({
      model: "",
      provider: "",
    });
  });
});
