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

  it("uses the single-brace placeholder syntax the interpolator understands", () => {
    // Regression: two settings strings shipped `{{count}}`/`{{reason}}`, but
    // `interpolate` matches `\{([A-Za-z][\w.-]*)\}` — so it substituted the
    // INNER braces and left the outer pair in the rendered text ("{5} failed
    // check(s)"). A double brace is always a bug, never an escape.
    for (const [lang, locale] of Object.entries(CATALOG)) {
      for (const [key, message] of Object.entries(locale)) {
        for (const form of typeof message === "string" ? [message] : Object.values(message)) {
          expect(form, `${lang}/${key}`).not.toMatch(/\{\{|\}\}/);
        }
      }
    }
  });

  it("keeps placeholder names identical across locales", () => {
    // A translated string that drops or renames a placeholder silently loses
    // the value at runtime — `interpolate` leaves unknown names untouched.
    // Deliberately `unknown`: the same helper reads both locales, whose value
    // types are distinct string-literal unions.
    const placeholders = (message: unknown) => {
      const forms = typeof message === "string"
        ? [message]
        : Object.values(message as Record<string, unknown>).filter((f): f is string => typeof f === "string");
      const names = new Set<string>();
      for (const form of forms) {
        for (const match of form.matchAll(/\{([A-Za-z][\w.-]*)\}/g)) names.add(match[1]!);
      }
      return [...names].sort();
    };

    for (const key of Object.keys(CATALOG.en) as (keyof typeof CATALOG.en)[]) {
      expect(placeholders(CATALOG.ru[key]), String(key)).toEqual(placeholders(CATALOG.en[key]));
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

  it("keeps Linux credential-storage recovery concrete and sandbox-safe", () => {
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxStep1"]).toContain("normal desktop user");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxStep1"]).toContain("AppImage");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxStep2"]).toContain("org.freedesktop.secrets");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxStep2"]).toContain("KWallet");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxArchCommand"]).toContain("pacman -S gnome-keyring");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxDebCommand"]).toContain("apt install gnome-keyring");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxKdeCommand"]).toContain("kwallet");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxWaylandHint"]).toContain("Hyprland");
    expect(CATALOG.en["settings.providers.error.secretStorageLinuxLocation"]).toContain("kyrei-secrets.json");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxStep1"]).toContain("обычным пользователем");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxStep1"]).toContain("AppImage");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxStep2"]).toContain("org.freedesktop.secrets");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxArchCommand"]).toContain("pacman -S gnome-keyring");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxDebCommand"]).toContain("apt install gnome-keyring");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxKdeCommand"]).toContain("kwallet");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxWaylandHint"]).toContain("Hyprland");
    expect(CATALOG.ru["settings.providers.error.secretStorageLinuxLocation"]).toContain("kyrei-secrets.json");
  });
});
