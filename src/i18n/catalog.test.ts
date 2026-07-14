import { describe, expect, expectTypeOf, it } from "vitest";
import { CATALOG, LANGUAGES, type TranslationKey } from "./catalog";

describe("translation catalog", () => {
  it("keeps English and Russian keys in exact parity", () => {
    const enKeys = Object.keys(CATALOG.en).sort();
    const ruKeys = Object.keys(CATALOG.ru).sort();

    expect(ruKeys).toEqual(enKeys);
    expectTypeOf<keyof typeof CATALOG.en>().toEqualTypeOf<keyof typeof CATALOG.ru>();
  });

  it("contains only non-empty messages", () => {
    for (const locale of Object.values(CATALOG)) {
      for (const message of Object.values(locale)) {
        if (typeof message === "string") {
          expect(message.trim()).not.toBe("");
          continue;
        }

        expect(message.other.trim()).not.toBe("");
      }
    }
  });

  it("exposes stable locale data without translating language names", () => {
    expect(LANGUAGES).toEqual([
      { id: "en", label: "English" },
      { id: "ru", label: "Русский" },
    ]);

    expectTypeOf<"common.cancel">().toMatchTypeOf<TranslationKey>();
  });

  it("keeps the protected-storage failure actionable in both locales", () => {
    expect(CATALOG.en["settings.providers.error.secretStorageTitle"]).toContain("securely save");
    expect(CATALOG.en["settings.providers.error.secretStorageStep2"]).toContain("return to Providers");
    expect(CATALOG.en["settings.providers.error.secretStorageNotSaved"]).toContain("plain text");

    expect(CATALOG.ru["settings.providers.error.secretStorageTitle"]).toContain("безопасно сохранить");
    expect(CATALOG.ru["settings.providers.error.secretStorageStep2"]).toContain("вернитесь в «Провайдеры»");
    expect(CATALOG.ru["settings.providers.error.secretStorageNotSaved"]).toContain("открытым текстом");
  });
});
