import { useEffect, useState } from "react";

export const THEMES = [
  { id: "dark", label: "Тёмная" },
  { id: "light", label: "Светлая" },
  { id: "midnight", label: "Полночь" },
  { id: "ember", label: "Ember" },
  { id: "mono", label: "Моно" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "slate", label: "Slate" },
] as const;

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
