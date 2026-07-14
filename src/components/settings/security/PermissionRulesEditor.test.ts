import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createExactCommandPermissionRule, type PermissionRule } from "@/lib/permission-rules";

async function renderEditor(lang: "en" | "ru", rules: PermissionRule[]): Promise<string> {
  vi.resetModules();
  const [{ I18nProvider, setLang }, { TooltipProvider }, { PermissionRulesEditor }] = await Promise.all([
    import("@/i18n"),
    import("@/components/ui"),
    import("./PermissionRulesEditor"),
  ]);
  setLang(lang);

  return renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(
      TooltipProvider,
      null,
      createElement(PermissionRulesEditor, { rules, onChange: () => undefined }),
    ),
  ));
}

describe("PermissionRulesEditor", () => {
  const rules: PermissionRule[] = [
    createExactCommandPermissionRule("npm test", "ask"),
    { pattern: "^run_command:npm (test|lint)$", action: "deny" },
    { pattern: "[", action: "allow" },
  ];

  it("renders generated, advanced, and invalid rules without hiding imported policy", async () => {
    const html = await renderEditor("en", rules);

    expect(html).toContain("Persistent access rules");
    expect(html).toContain("Exact command");
    expect(html).toContain("npm test");
    expect(html).toContain("Advanced regex");
    expect(html).toContain("Invalid legacy rule");
    expect(html).toContain("Imported advanced patterns stay read-only");
    expect(html).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("keeps the same policy surface localized in Russian", async () => {
    const html = await renderEditor("ru", rules);

    expect(html).toContain("Постоянные правила доступа");
    expect(html).toContain("Точная команда");
    expect(html).toContain("Расширенный regex");
    expect(html).toContain("Некорректное старое правило");
  });

  it("truthfully marks a legacy web Ask rule as unsupported", async () => {
    const html = await renderEditor("en", [
      { pattern: "^web_search(?::[\\s\\S]*)?$(?![\\s\\S])", action: "ask" },
    ]);

    expect(html).toContain("Unsupported approval rule");
    expect(html).toContain("Ask is not available for web tools yet");
    expect(html).not.toContain('aria-label="Edit rule"');
  });
});
