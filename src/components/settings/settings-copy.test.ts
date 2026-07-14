import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSettings(
  lang: "en" | "ru",
  initialSection: "model" | "providers" | "workspace" | "skills" | "chat" | "memory" | "appearance" | "notifications" | "keybinds" | "advanced" | "about" = "model",
): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

  const [{ I18nProvider, setLang }, { Settings }, { TooltipProvider }] = await Promise.all([
    import("@/i18n"),
    import("@/components/Settings"),
    import("@/components/ui"),
  ]);
  setLang(lang);

  return renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(
      TooltipProvider,
      null,
      createElement(Settings, {
        config: {
          provider: "https://api.example.com/v1",
          model: "model-1",
          workspace: "",
          hasKey: false,
          activeProviderId: "provider-1",
          activeProviderName: "Example",
          activeModelId: "model-1",
          providers: [{
            id: "provider-1",
            name: "Example",
            protocol: "openai-chat",
            baseURL: "https://api.example.com/v1",
            models: [{ id: "model-1" }],
            enabled: true,
            requiresApiKey: true,
            hasKey: false,
          }],
          engine: {},
        },
        onClose: () => undefined,
        onSaved: () => undefined,
        initialSection,
      }),
    ),
  ));
}

describe("settings localized rendering", () => {
  it("renders the settings shell in English", async () => {
    const html = await renderSettings("en");

    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain("Model");
    expect(html).toContain("Workspace &amp; safety");
    expect(html).toContain('aria-label="Settings section"');
    expect(html).toContain("Providers");
    expect(html).toContain("Team mode");
    expect(html).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("renders the same surface in Russian", async () => {
    const html = await renderSettings("ru");

    expect(html).toContain('aria-label="Настройки"');
    expect(html).toContain("Модель");
    expect(html).toContain("Рабочая среда и безопасность");
    expect(html).toContain('aria-label="Раздел настроек"');
    expect(html).toContain("Провайдеры");
    expect(html).toContain("Командный режим");
  });

  it("renders locale-owned theme labels", async () => {
    expect(await renderSettings("en", "appearance")).toContain("Dark");
    expect(await renderSettings("ru", "appearance")).toContain("Тёмная");
  });

  it("keeps the official Kiro identity separate from the organization control plane", async () => {
    const english = await renderSettings("en", "providers");
    const russian = await renderSettings("ru", "providers");

    expect(english).toContain("Kiro CLI · official connector");
    expect(english).toContain("Kiro Organization · protected account pool");
    expect(russian).toContain("Kiro CLI · официальный коннектор");
    expect(russian).toContain("Kiro Organization · защищённый пул аккаунтов");
  });

  it("contains no Russian hardcode in any English settings section", async () => {
    const sections = ["model", "providers", "workspace", "skills", "chat", "memory", "appearance", "notifications", "keybinds", "advanced", "about"] as const;
    for (const section of sections) {
      const html = (await renderSettings("en", section)).replaceAll("Русский", "");
      expect(html, section).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
});
