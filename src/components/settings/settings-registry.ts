import type { TranslationKey } from "@/i18n";

export type SettingsSectionId =
  | "general"
  | "workspace"
  | "chat"
  | "memory"
  | "appearance"
  | "notifications"
  | "voice"
  | "keybinds"
  | "advanced"
  | "about";

export type VisibleSettingsSectionId = Exclude<SettingsSectionId, "voice">;

export const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "settings.sections.general" },
  { id: "workspace", labelKey: "settings.sections.workspace" },
  { id: "chat", labelKey: "settings.sections.chat" },
  { id: "memory", labelKey: "settings.sections.memory" },
  { id: "appearance", labelKey: "settings.sections.appearance" },
  { id: "notifications", labelKey: "settings.sections.notifications" },
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
