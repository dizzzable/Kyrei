import type {
  DocumentLanguageTarget,
  Lang,
  MessageCatalog,
  MessageValue,
  PluralCategory,
  StorageReader,
  TranslationParams,
  Translator,
} from "./types";

export const LANGUAGE_STORAGE_KEY = "kyrei-lang";

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "ru";
}

function browserStorage(): StorageReader | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function systemLanguages(): readonly string[] | undefined {
  if (typeof navigator === "undefined") return undefined;
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : undefined;
}

function storedLanguage(storage: StorageReader | undefined): Lang | undefined {
  try {
    const stored = storage?.getItem(LANGUAGE_STORAGE_KEY);
    return isLang(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function supportedSystemLanguage(locales: readonly string[] | undefined): Lang | undefined {
  for (const locale of locales ?? []) {
    const language = locale.trim().toLowerCase().split(/[-_]/, 1)[0];
    if (isLang(language)) return language;
  }
  return undefined;
}

/** Resolve persisted -> system -> English, accepting only the supported locale allowlist. */
export function resolveInitialLang(
  storage: StorageReader | undefined = browserStorage(),
  locales: readonly string[] | undefined = systemLanguages(),
): Lang {
  return storedLanguage(storage) ?? supportedSystemLanguage(locales) ?? "en";
}

export function syncDocumentLang(
  lang: Lang,
  target: DocumentLanguageTarget | undefined =
    typeof document === "undefined" ? undefined : document,
): void {
  if (target) target.documentElement.lang = lang;
}

function selectMessage(value: MessageValue, lang: Lang, params?: TranslationParams): string {
  if (typeof value === "string") return value;

  const count = params?.count;
  if (typeof count !== "number" || !Number.isFinite(count)) return value.other;
  if (count === 0 && value.zero) return value.zero;

  const category = new Intl.PluralRules(lang).select(count) as PluralCategory;
  return value[category] ?? value.other;
}

function interpolate(message: string, lang: Lang, params?: TranslationParams): string {
  return message.replace(/\{([A-Za-z][\w.-]*)\}/g, (placeholder, name: string) => {
    if (!params || !Object.prototype.hasOwnProperty.call(params, name)) return placeholder;
    const value = params[name];
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return new Intl.NumberFormat(lang).format(value);
    return String(value);
  });
}

export function createTranslator<TCatalog extends MessageCatalog>(
  catalog: TCatalog,
  lang: Lang,
): Translator<Extract<keyof TCatalog, string>> {
  return (key, params) => {
    const value = catalog[key];
    if (value === undefined) return key;
    return interpolate(selectMessage(value, lang, params), lang, params);
  };
}
