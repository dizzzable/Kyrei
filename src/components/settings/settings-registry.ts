import type { TranslationKey } from "@/i18n";

export type SettingsSectionId =
  | "model"
  | "providers"
  | "workspace"
  | "skills"
  | "chat"
  | "memory"
  | "sessions"
  | "usage"
  | "organization"
  | "capacity"
  | "appearance"
  | "notifications"
  | "voice"
  | "keybinds"
  | "advanced"
  | "about";

export type VisibleSettingsSectionId = Exclude<SettingsSectionId, "voice">;

export const SETTINGS_SECTIONS = [
  { id: "model", labelKey: "settings.sections.model" },
  { id: "chat", labelKey: "settings.sections.chat" },
  { id: "appearance", labelKey: "settings.sections.appearance" },
  { id: "workspace", labelKey: "settings.sections.workspace" },
  { id: "memory", labelKey: "settings.sections.memory" },
  { id: "sessions", labelKey: "settings.sections.sessions" },
  { id: "usage", labelKey: "settings.sections.usage" },
  { id: "organization", labelKey: "settings.sections.organization" },
  { id: "capacity", labelKey: "settings.sections.capacity" },
  { id: "notifications", labelKey: "settings.sections.notifications" },
  { id: "providers", labelKey: "settings.sections.providers" },
  { id: "skills", labelKey: "settings.sections.skills" },
  { id: "keybinds", labelKey: "settings.sections.keybinds" },
  { id: "advanced", labelKey: "settings.sections.advanced" },
  { id: "about", labelKey: "settings.sections.about" },
] as const satisfies readonly {
  id: VisibleSettingsSectionId;
  labelKey: TranslationKey;
}[];

export function resolveSettingsSection(section: SettingsSectionId): VisibleSettingsSectionId {
  return section === "voice" ? "notifications" : section;
}
