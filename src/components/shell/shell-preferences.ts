import { useEffect, useState } from "react";

export const SHELL_PREFERENCES_KEY = "kyrei.shell.preferences.v2";

export interface ShellPreferences {
  developerOpen: boolean;
  activityOpen: boolean;
  swapped: boolean;
  developerWidth: number;
  activityWidth: number;
  developerSplit: number;
}

export const DEFAULT_SHELL_PREFERENCES: Readonly<ShellPreferences> = {
  developerOpen: true,
  activityOpen: true,
  swapped: false,
  developerWidth: 288,
  activityWidth: 296,
  developerSplit: 0.62,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function normalizeShellPreferences(value: unknown): ShellPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_SHELL_PREFERENCES };
  const candidate = value as Partial<ShellPreferences>;

  return {
    developerOpen: typeof candidate.developerOpen === "boolean" ? candidate.developerOpen : DEFAULT_SHELL_PREFERENCES.developerOpen,
    activityOpen: typeof candidate.activityOpen === "boolean" ? candidate.activityOpen : DEFAULT_SHELL_PREFERENCES.activityOpen,
    swapped: typeof candidate.swapped === "boolean" ? candidate.swapped : DEFAULT_SHELL_PREFERENCES.swapped,
    developerWidth: clamp(candidate.developerWidth, 240, 440, DEFAULT_SHELL_PREFERENCES.developerWidth),
    activityWidth: clamp(candidate.activityWidth, 240, 420, DEFAULT_SHELL_PREFERENCES.activityWidth),
    developerSplit: clamp(candidate.developerSplit, 0.34, 0.82, DEFAULT_SHELL_PREFERENCES.developerSplit),
  };
}

export function parseShellPreferences(raw: string | null): ShellPreferences {
  if (!raw) return { ...DEFAULT_SHELL_PREFERENCES };
  try {
    return normalizeShellPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SHELL_PREFERENCES };
  }
}

export function serializeShellPreferences(value: ShellPreferences): string {
  return JSON.stringify(normalizeShellPreferences(value));
}

export function parseLegacyShellPreferences(values: {
  explorerOpen: string | null;
  sidebarOpen: string | null;
  explorerWidth: string | null;
  sidebarWidth: string | null;
}): ShellPreferences | null {
  if (Object.values(values).every(value => value === null)) return null;
  return normalizeShellPreferences({
    ...DEFAULT_SHELL_PREFERENCES,
    developerOpen: values.explorerOpen === null ? DEFAULT_SHELL_PREFERENCES.developerOpen : values.explorerOpen === "true",
    activityOpen: values.sidebarOpen === null ? DEFAULT_SHELL_PREFERENCES.activityOpen : values.sidebarOpen === "true",
    developerWidth: values.explorerWidth === null ? DEFAULT_SHELL_PREFERENCES.developerWidth : Number(values.explorerWidth),
    activityWidth: values.sidebarWidth === null ? DEFAULT_SHELL_PREFERENCES.activityWidth : Number(values.sidebarWidth),
  });
}

function readPreferences(): ShellPreferences {
  try {
    const current = localStorage.getItem(SHELL_PREFERENCES_KEY);
    if (current !== null) return parseShellPreferences(current);
    const migrated = parseLegacyShellPreferences({
      explorerOpen: localStorage.getItem("kyrei-explorer-open"),
      sidebarOpen: localStorage.getItem("kyrei-sidebar-open"),
      explorerWidth: localStorage.getItem("kyrei-explorer-w"),
      sidebarWidth: localStorage.getItem("kyrei-sidebar-w"),
    });
    if (migrated) localStorage.setItem(SHELL_PREFERENCES_KEY, serializeShellPreferences(migrated));
    return migrated ?? { ...DEFAULT_SHELL_PREFERENCES };
  } catch {
    return { ...DEFAULT_SHELL_PREFERENCES };
  }
}

function persistPreferences(value: ShellPreferences): void {
  try {
    localStorage.setItem(SHELL_PREFERENCES_KEY, serializeShellPreferences(value));
  } catch {
    // Storage is best-effort in restricted renderer contexts.
  }
}

export function useShellPreferences() {
  const [preferences, setPreferences] = useState<ShellPreferences>(readPreferences);

  useEffect(() => {
    persistPreferences(preferences);
  }, [preferences]);

  const patch = (next: Partial<ShellPreferences>) => {
    setPreferences((current) => normalizeShellPreferences({ ...current, ...next }));
  };

  return { preferences, patch } as const;
}
