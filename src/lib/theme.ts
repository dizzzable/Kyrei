import { useEffect, useState } from "react";
import type { TranslationKey } from "@/i18n";

export const THEMES = [
  { id: "dark", labelKey: "settings.theme.dark" },
  { id: "light", labelKey: "settings.theme.light" },
  { id: "midnight", labelKey: "settings.theme.midnight" },
  { id: "ember", labelKey: "settings.theme.ember" },
  { id: "mono", labelKey: "settings.theme.mono" },
  { id: "cyberpunk", labelKey: "settings.theme.cyberpunk" },
  { id: "slate", labelKey: "settings.theme.slate" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "kyrei-theme";
const EVENT = "kyrei-theme-change";

export function getTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY);
    if (t && THEMES.some(x => x.id === t)) return t as ThemeId;
  } catch { /* ignore */ }
  return "dark";
}

export function applyTheme(id: ThemeId): void {
  // Selecting a preset clears any imported custom-theme override so the preset
  // wins again (custom seeds are inline styles, which outrank [data-theme]).
  try {
    const el = document.documentElement;
    for (const k of ["bg", "surface", "elevated", "border", "foreground", "primary", "primary-strong", "user", "success", "danger", "warning"]) {
      el.style.removeProperty(`--k-${k}`);
    }
    el.style.colorScheme = "";
    localStorage.removeItem("kyrei-custom-active");
  } catch { /* ignore */ }
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

/** Reactive current theme id, updates when applyTheme runs. */
export function useThemeId(): ThemeId {
  const [id, setId] = useState<ThemeId>(getTheme());
  useEffect(() => {
    const on = (e: Event) => setId((e as CustomEvent<ThemeId>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return id;
}
