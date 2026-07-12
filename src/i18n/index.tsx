import { createContext, useContext, useMemo, type ReactNode } from "react";
import { persistentStringAtom, useAtom } from "@/store/atom";
import { CATALOG, type Dict, type Lang } from "./catalog";

const LANG_KEY = "kyrei-lang";
export const $lang = persistentStringAtom(LANG_KEY, "ru") as unknown as {
  get(): Lang;
  set(v: Lang): void;
  subscribe(l: () => void): () => void;
};

export function setLang(lang: Lang): void {
  $lang.set(lang);
  document.documentElement.lang = lang;
}

const I18nContext = createContext<{ t: Dict; lang: Lang }>({ t: CATALOG.ru, lang: "ru" });

export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useAtom($lang) as Lang;
  const value = useMemo(() => ({ t: CATALOG[lang] ?? CATALOG.ru, lang }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Хук доступа к строкам: `const { t, lang } = useI18n()`. */
export function useI18n() {
  return useContext(I18nContext);
}

export type { Lang, Dict } from "./catalog";
export { LANGUAGES } from "./catalog";
