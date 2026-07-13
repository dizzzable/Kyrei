import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ShellLayout } from "./ShellLayout";
import { ACTIVITY_REGISTRY, settingsSectionForActivity } from "./activity-registry";
import {
  DEFAULT_SHELL_PREFERENCES,
  parseLegacyShellPreferences,
  parseShellPreferences,
  serializeShellPreferences,
} from "./shell-preferences";
import { createTranslator } from "@/i18n/translate";
import { enShell } from "@/i18n/locales/en/shell";
import { ruShell } from "@/i18n/locales/ru/shell";

describe("Hermes-inspired desktop shell", () => {
  it("keeps developer, conversation and activity panes in the physical default order", () => {
    const html = renderToStaticMarkup(
      createElement(ShellLayout, {
        developer: createElement("div", { "data-pane": "developer" }),
        conversation: createElement("main", { "data-pane": "conversation" }),
        activity: createElement("aside", { "data-pane": "activity" }),
        developerOpen: true,
        activityOpen: true,
        swapped: false,
        developerWidth: 288,
        activityWidth: 296,
      }),
    );

    expect(html.indexOf('data-pane="developer"')).toBeLessThan(html.indexOf('data-pane="conversation"'));
    expect(html.indexOf('data-pane="conversation"')).toBeLessThan(html.indexOf('data-pane="activity"'));
  });

  it("declares every requested activity destination exactly once", () => {
    expect(ACTIVITY_REGISTRY.map((item) => item.id)).toEqual([
      "sessions",
      "capabilities",
      "messaging",
      "artifacts",
      "memory",
      "providers",
    ]);
    expect(new Set(ACTIVITY_REGISTRY.map((item) => item.labelKey)).size).toBe(6);
  });

  it("routes enabled activity rows to their existing task-specific settings", () => {
    expect(settingsSectionForActivity("capabilities")).toBe("skills");
    expect(settingsSectionForActivity("memory")).toBe("memory");
    expect(settingsSectionForActivity("providers")).toBe("providers");
  });

  it("provides real English and Russian labels for shell navigation", () => {
    const en = createTranslator(enShell, "en");
    const ru = createTranslator(ruShell, "ru");

    expect(en("shell.activity.memory")).toBe("Memory");
    expect(ru("shell.activity.memory")).toBe("Память");
    expect(ru("shell.session.new")).not.toBe(en("shell.session.new"));
  });

  it("round-trips persistent widths, collapse and side-swap preferences safely", () => {
    const encoded = serializeShellPreferences({
      developerOpen: false,
      activityOpen: true,
      swapped: true,
      developerWidth: 900,
      activityWidth: 90,
      developerSplit: 0.98,
    });

    expect(parseShellPreferences(encoded)).toEqual({
      developerOpen: false,
      activityOpen: true,
      swapped: true,
      developerWidth: 440,
      activityWidth: 240,
      developerSplit: 0.82,
    });
    expect(parseShellPreferences("not json")).toEqual(DEFAULT_SHELL_PREFERENCES);
  });

  it("migrates the previous sidebar and explorer preferences", () => {
    expect(parseLegacyShellPreferences({
      explorerOpen: "false",
      sidebarOpen: "true",
      explorerWidth: "310",
      sidebarWidth: "260",
    })).toMatchObject({
      developerOpen: false,
      activityOpen: true,
      developerWidth: 310,
      activityWidth: 260,
    });
    expect(parseLegacyShellPreferences({ explorerOpen: null, sidebarOpen: null, explorerWidth: null, sidebarWidth: null })).toBeNull();
  });
});
