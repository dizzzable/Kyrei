import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSettings(
  lang: "en" | "ru",
  initialSection: "model" | "providers" | "workspace" | "skills" | "chat" | "memory" | "appearance" | "notifications" | "keybinds" | "advanced" | "about" = "model",
  engine: Record<string, unknown> = {},
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
          engine,
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

  it("explains the local GBrain setup before any agent memory is enabled", async () => {
    const english = await renderSettings("en", "memory");
    const russian = await renderSettings("ru", "memory");

    expect(english).toContain("Local GBrain setup");
    expect(english).toContain("Checking local GBrain…");
    expect(english).toContain("Check status");
    expect(russian).toContain("Локальная настройка GBrain");
    expect(russian).toContain("Проверяю локальный GBrain…");
    expect(russian).toContain("Проверить статус");
  });

  it("exposes built-in project memory controls (LTM, index, OpenViking)", async () => {
    const english = await renderSettings("en", "memory");
    const russian = await renderSettings("ru", "memory");

    expect(english).toContain("Project memory");
    expect(english).toContain("Built-in durable memory");
    expect(english).toContain("Long-term memory (LTM)");
    expect(english).toContain("Hybrid search index");
    expect(english).toContain("Rebuild index");
    expect(english).toContain("Chat session mirror");
    expect(english).toContain("Vector embeddings");
    expect(english).toContain("MCP servers");
    expect(english).toContain("Enable MCP client");
    expect(russian).toContain("Память проекта");
    expect(russian).toContain("Встроенная долговременная память");
    expect(russian).toContain("Долговременная память (LTM)");
    expect(russian).toContain("Гибридный поисковый индекс");
    expect(russian).toContain("Пересобрать индекс");
    expect(russian).toContain("Зеркало чат-сессий");
    expect(russian).toContain("Векторные эмбеддинги");
    expect(russian).toContain("MCP-серверы");
    expect(russian).toContain("Включить MCP-клиент");
  });

  it("explains that standalone Skills work and can be selected for one task", async () => {
    const english = await renderSettings("en", "skills");
    const russian = await renderSettings("ru", "skills");

    expect(english).toContain("How Skills are used");
    expect(english).toContain("A single SKILL.md is a complete Skill");
    expect(english).toContain("Skills for this task");
    expect(russian).toContain("Как используются skills");
    expect(russian).toContain("Один файл SKILL.md — полноценный skill");
    expect(russian).toContain("Skills для этой задачи");
  });

  it("renders update controls on About", async () => {
    const english = await renderSettings("en", "about");
    const russian = await renderSettings("ru", "about");

    expect(english).toContain("Updates");
    expect(english).toContain("Check for updates");
    expect(english).toContain("All releases");
    expect(english).toContain("download and install from here after confirming");
    expect(russian).toContain("Обновления");
    expect(russian).toContain("Проверить обновления");
    expect(russian).toContain("Все релизы");
    expect(russian).toContain("скачать и установить отсюда после подтверждения");
  });

  it("renders the guided persistent permission editor in both locales", async () => {
    const english = await renderSettings("en", "workspace");
    const russian = await renderSettings("ru", "workspace");

    expect(english).toContain("Persistent access rules");
    expect(english).toContain("Global policies only");
    expect(english).toContain("Add rule");
    expect(russian).toContain("Постоянные правила доступа");
    expect(russian).toContain("Только глобальные политики");
    expect(russian).toContain("Добавить правило");
  });

  it("locks guided mutations instead of dropping malformed fail-closed legacy rules", async () => {
    const html = await renderSettings("en", "workspace", {
      permissions: {
        rules: [
          { pattern: "^run_command:publish$", action: "sometimes" },
          { pattern: "[", action: "deny" },
        ],
      },
    });

    expect(html).toContain("2 persisted rule entries cannot be represented safely here");
    expect(html).toContain("Guided changes are locked");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*Add rule/s);
  });

  it("also locks present null permission containers and rule arrays", async () => {
    const nullPermissions = await renderSettings("en", "workspace", { permissions: null });
    const nullRules = await renderSettings("en", "workspace", { permissions: { rules: null } });

    expect(nullPermissions).toContain("1 persisted rule entries cannot be represented safely here");
    expect(nullRules).toContain("1 persisted rule entries cannot be represented safely here");
    expect(nullPermissions).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*Add rule/s);
    expect(nullRules).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*Add rule/s);
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
