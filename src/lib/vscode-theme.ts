/**
 * VS Code theme import (Wave 1.2, optional). Parses a `.json`/JSONC color theme
 * locally and maps ~10 of its `colors` keys onto Kyrei's `--k-*` seeds, which
 * then flow through the token cascade in index.css. Purely offline: the file is
 * read via a file picker, never fetched.
 */

const SEED_KEYS = [
  "bg",
  "surface",
  "elevated",
  "border",
  "foreground",
  "primary",
  "primary-strong",
  "user",
  "success",
  "danger",
  "warning",
] as const;

export type SeedKey = (typeof SEED_KEYS)[number];
export type CustomSeeds = Record<SeedKey, string> & { scheme: "dark" | "light"; name: string };

const STORE_KEY = "kyrei-custom-theme";
const ACTIVE_KEY = "kyrei-custom-active";

/** Strip JSONC comments + trailing commas so a VS Code theme parses as JSON. */
function parseJsonc(text: string): unknown {
  const noComments = text
    .replace(/\\"|"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/.*$/gm, (m) => (m.startsWith("/") ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noComments);
}

/** Normalize a VS Code color to a 6-digit hex (drop alpha channel if present). */
function hex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(value.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8 || h.length === 4) h = h.slice(0, h.length === 4 ? 3 : 6);
  return `#${h.slice(0, 6)}`;
}

/** Relative luminance (0=black, 1=white) for a #rrggbb color. */
function luminance(h: string): number {
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pick(colors: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const k of keys) {
    const v = hex(colors[k]);
    if (v) return v;
  }
  return fallback;
}

/** Parse a VS Code theme document into Kyrei seeds, or null if unusable. */
export function parseVscodeTheme(text: string, fileName = "custom"): CustomSeeds | null {
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const root = doc as Record<string, unknown>;
  const colors = (root.colors && typeof root.colors === "object" ? root.colors : {}) as Record<string, unknown>;

  const bg = hex(colors["editor.background"]) ?? hex(colors["background"]);
  const fg = hex(colors["editor.foreground"]) ?? hex(colors["foreground"]);
  if (!bg || !fg) return null;

  const scheme: "dark" | "light" =
    root.type === "light" || root.type === "dark" ? (root.type as "dark" | "light") : luminance(bg) > 0.5 ? "light" : "dark";

  const primary = pick(colors, ["button.background", "focusBorder", "textLink.foreground", "progressBar.background"], "#5b7cfa");

  return {
    scheme,
    name: root.name ? String(root.name) : fileName,
    bg,
    surface: pick(colors, ["sideBar.background", "panel.background", "editorGroupHeader.tabsBackground"], bg),
    elevated: pick(colors, ["editorWidget.background", "dropdown.background", "input.background", "menu.background"], bg),
    border: pick(colors, ["panel.border", "editorGroup.border", "focusBorder", "contrastBorder", "input.border"], scheme === "light" ? "#d8dce3" : "#2a3039"),
    foreground: fg,
    primary,
    "primary-strong": pick(colors, ["button.hoverBackground"], primary),
    user: pick(colors, ["input.background", "editor.selectionBackground"], scheme === "light" ? "#e5eafe" : "#222a44"),
    success: pick(colors, ["gitDecoration.addedResourceForeground", "terminal.ansiGreen", "charts.green"], "#35c08a"),
    danger: pick(colors, ["editorError.foreground", "errorForeground", "terminal.ansiRed", "charts.red"], "#ef5f6b"),
    warning: pick(colors, ["editorWarning.foreground", "terminal.ansiYellow", "charts.yellow"], "#e0a94b"),
  };
}

/** Push custom seeds onto <html> as inline `--k-*` (inline wins over presets). */
export function applyCustomTheme(seeds: CustomSeeds): void {
  const el = document.documentElement;
  for (const key of SEED_KEYS) el.style.setProperty(`--k-${key}`, seeds[key]);
  el.style.colorScheme = seeds.scheme;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(seeds));
    localStorage.setItem(ACTIVE_KEY, "true");
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(new CustomEvent("kyrei-theme-change", { detail: "custom" }));
}

/** Remove the inline seed overrides so the selected preset takes over again. */
export function clearCustomTheme(): void {
  const el = document.documentElement;
  for (const key of SEED_KEYS) el.style.removeProperty(`--k-${key}`);
  el.style.colorScheme = "";
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

export function isCustomThemeActive(): boolean {
  try {
    return localStorage.getItem(ACTIVE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storedCustomTheme(): CustomSeeds | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as CustomSeeds) : null;
  } catch {
    return null;
  }
}

/** Boot restore: re-apply the custom theme if it was the active choice. */
export function restoreCustomTheme(): void {
  if (!isCustomThemeActive()) return;
  const seeds = storedCustomTheme();
  if (seeds) applyCustomTheme(seeds);
}
