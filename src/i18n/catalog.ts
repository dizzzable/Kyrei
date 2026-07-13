import { enChat } from "./locales/en/chat";
import { enCommon } from "./locales/en/common";
import { enSettings } from "./locales/en/settings";
import { enShell } from "./locales/en/shell";
import { ruChat } from "./locales/ru/chat";
import { ruCommon } from "./locales/ru/common";
import { ruSettings } from "./locales/ru/settings";
import { ruShell } from "./locales/ru/shell";
import type { LanguageOption, LocaleFor, MessageCatalog } from "./types";

export const enCatalog = {
  ...enCommon,
  ...enShell,
  ...enChat,
  ...enSettings,
} as const satisfies MessageCatalog;

export const ruCatalog = {
  ...ruCommon,
  ...ruShell,
  ...ruChat,
  ...ruSettings,
} as const satisfies LocaleFor<typeof enCatalog>;

export const CATALOG = {
  en: enCatalog,
  ru: ruCatalog,
} as const;

export type TranslationKey = Extract<keyof typeof enCatalog, string>;

export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "ru", label: "Русский" },
] as const satisfies readonly LanguageOption[];
