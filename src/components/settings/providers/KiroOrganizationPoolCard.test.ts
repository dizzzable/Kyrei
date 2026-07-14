import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderCard(lang: "en" | "ru"): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("location", { search: "" });

  const [{ I18nProvider, setLang }, { TooltipProvider }, { KiroOrganizationPoolCard }] = await Promise.all([
    import("@/i18n"),
    import("@/components/ui"),
    import("./KiroOrganizationPoolCard"),
  ]);
  setLang(lang);

  return renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(TooltipProvider, null, createElement(KiroOrganizationPoolCard)),
  ));
}

describe("Kiro organization pool card", () => {
  it("renders the separate protected control-plane boundary in English", async () => {
    const html = await renderCard("en");

    expect(html).toContain("Kiro Organization · protected account pool");
    expect(html).toContain("separate protected headless account control plane");
    expect(html).not.toContain('type="password"');
  });

  it("renders the same boundary from the Russian locale", async () => {
    const html = await renderCard("ru");

    expect(html).toContain("Kiro Organization · защищённый пул аккаунтов");
    expect(html).toContain("отдельный защищённый headless-контур аккаунтов");
  });
});
