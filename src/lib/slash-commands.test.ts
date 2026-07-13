import { describe, expect, it } from "vitest";

import {
  canonicalSlashCommand,
  getSlashCommands,
  isModelPickerCommand,
  isPickerCommand,
  isSlashCommand,
  isSlashSuggestion,
  parseSlash,
  resolveSlashCommand,
  slashCommandTakesArgs,
  slashDescription,
} from "@/lib/slash-commands";
import { createTranslator } from "@/i18n/translate";
import { enChat } from "@/i18n/locales/en/chat";
import { ruChat } from "@/i18n/locales/ru/chat";

const en = createTranslator(enChat, "en");
const ru = createTranslator(ruChat, "ru");

describe("resolve / canonical", () => {
  it("parses a command into the legacy bare-name dispatch shape", () => {
    expect(parseSlash("/theme midnight")).toEqual({ name: "theme", arg: "midnight" });
    expect(parseSlash("//MODEL  gpt-5")).toEqual({ name: "model", arg: "gpt-5" });
  });

  it("resolves /new and its aliases to the same canonical spec", () => {
    expect(canonicalSlashCommand("/new")).toBe("/new");
    expect(canonicalSlashCommand("/clear")).toBe("/new");
    expect(canonicalSlashCommand("/reset")).toBe("/new");

    const spec = resolveSlashCommand("/clear");
    expect(spec?.name).toBe("/new");
    expect(spec?.surface).toEqual({ kind: "action", action: "new" });
  });

  it("normalizes casing, missing slash, and trailing args", () => {
    expect(canonicalSlashCommand("NEW")).toBe("/new");
    expect(canonicalSlashCommand("  /Reset  ")).toBe("/new");
    expect(canonicalSlashCommand("/theme dark")).toBe("/theme");
  });

  it("returns identity + null for an unknown command", () => {
    expect(canonicalSlashCommand("/bogus")).toBe("/bogus");
    expect(resolveSlashCommand("/bogus")).toBeNull();
  });
});

describe("isSlashCommand (execution gating)", () => {
  it("is true for known commands and their aliases", () => {
    expect(isSlashCommand("/new")).toBe(true);
    expect(isSlashCommand("/clear")).toBe(true);
    expect(isSlashCommand("/model")).toBe(true);
  });

  it("treats an unknown command as an extension command (executable)", () => {
    expect(isSlashCommand("/bogus")).toBe(true);
    expect(isSlashCommand("/")).toBe(false);
  });
});

describe("isSlashSuggestion (popover discovery)", () => {
  it("suggests canonical visible commands", () => {
    expect(isSlashSuggestion("/new")).toBe(true);
    expect(isSlashSuggestion("/help")).toBe(true);
    expect(isSlashSuggestion("/theme")).toBe(true);
  });

  it("hides aliases so the popover isn't cluttered", () => {
    expect(isSlashSuggestion("/clear")).toBe(false);
    expect(isSlashSuggestion("/reset")).toBe(false);
    expect(isSlashSuggestion("/commands")).toBe(false);
  });

  it("hides the model picker (reachable from chrome)", () => {
    expect(isSlashSuggestion("/model")).toBe(false);
  });

  it("surfaces unknown extension commands", () => {
    expect(isSlashSuggestion("/bogus")).toBe(true);
  });
});

describe("picker / description / takesArgs", () => {
  it("identifies the model picker", () => {
    expect(isPickerCommand("/model")).toBe(true);
    expect(isModelPickerCommand("/model")).toBe(true);
    expect(isPickerCommand("/new")).toBe(false);
  });

  it("exposes descriptions via alias", () => {
    expect(slashDescription("/new", en)).toBe("Start a new chat");
    expect(slashDescription("/clear", ru)).toBe("Начать новый диалог");
    expect(slashDescription("/bogus", en, "fallback")).toBe("fallback");
  });

  it("flags the two-step arg command", () => {
    expect(slashCommandTakesArgs("/theme")).toBe(true);
    expect(slashCommandTakesArgs("/new")).toBe(false);
  });
});

describe("localized command registry", () => {
  it("derives the palette from locale-neutral ids", () => {
    const english = getSlashCommands(en);
    const russian = getSlashCommands(ru);

    expect(english.map((command) => command.id)).toEqual(["new", "help", "theme", "settings"]);
    expect(english[0]).toMatchObject({
      id: "new",
      name: "new",
      command: "/new",
      desc: "Start a new chat",
    });
    expect(russian[0]?.desc).toBe("Начать новый диалог");
    expect(russian.find((command) => command.id === "theme")?.arg).toBe("dark | light | midnight");
  });
});
