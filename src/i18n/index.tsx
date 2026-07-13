import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { atom, useAtom, type Atom } from "@/store/atom";
import { persistString } from "@/lib/persist";
import { CATALOG, LANGUAGES, type TranslationKey } from "./catalog";
import {
  createTranslator,
  isLang,
  LANGUAGE_STORAGE_KEY,
  resolveInitialLang,
  syncDocumentLang,
} from "./translate";
import type { I18nApi, Lang } from "./types";

const initialLang = resolveInitialLang();
const langState = atom<Lang>(initialLang);

function applyLanguage(lang: Lang): void {
  persistString(LANGUAGE_STORAGE_KEY, lang);
  syncDocumentLang(lang);
}

applyLanguage(initialLang);

export const $lang: Atom<Lang> = {
  get: langState.get,
  set(next) {
    const previous = langState.get();
    const candidate = typeof next === "function" ? next(previous) : next;
    const lang = isLang(candidate) ? candidate : "en";
    langState.set(lang);
    applyLanguage(lang);
  },
  subscribe: langState.subscribe,
};

export function setLang(lang: Lang): void {
  $lang.set(lang);
}

function createI18nApi(lang: Lang): I18nApi<TranslationKey> {
  return {
    t: createTranslator(CATALOG[lang], lang),
    lang,
    number: (value, options) => new Intl.NumberFormat(lang, options).format(value),
    date: (value, options) => new Intl.DateTimeFormat(lang, options).format(value),
  };
}

const I18nContext = createContext<I18nApi<TranslationKey>>(createI18nApi(initialLang));

export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useAtom($lang);
  const value = useMemo(() => createI18nApi(lang), [lang]);

  useEffect(() => {
    syncDocumentLang(lang);
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Typed locale access: `const { t, lang, number, date } = useI18n()`. */
export function useI18n(): I18nApi<TranslationKey> {
  return useContext(I18nContext);
}

export { LANGUAGES };
export type { TranslationKey } from "./catalog";
export type {
  DateFormatter,
  I18nApi,
  Lang,
  MessageCatalog,
  MessageValue,
  NumberFormatter,
  PluralMessage,
  TranslationParams,
  Translator,
} from "./types";
