import type { enShell } from "@/i18n/locales/en/shell";
import type { SettingsSectionId } from "@/components/settings/settings-registry";

export type ActivityId = "sessions" | "capabilities" | "messaging" | "artifacts" | "memory" | "providers";
export type ShellTranslationKey = Extract<keyof typeof enShell, string>;

export interface ActivityDefinition {
  id: ActivityId;
  labelKey: ShellTranslationKey;
  descriptionKey: ShellTranslationKey;
  adapter: "sessions" | "settings" | "unavailable";
  settingsSection?: SettingsSectionId;
}

export const ACTIVITY_REGISTRY: readonly ActivityDefinition[] = [
  { id: "sessions", labelKey: "shell.activity.sessions", descriptionKey: "shell.activity.sessionsDescription", adapter: "sessions" },
  { id: "capabilities", labelKey: "shell.activity.capabilities", descriptionKey: "shell.activity.capabilitiesDescription", adapter: "settings", settingsSection: "skills" },
  { id: "messaging", labelKey: "shell.activity.messaging", descriptionKey: "shell.activity.messagingDescription", adapter: "unavailable" },
  { id: "artifacts", labelKey: "shell.activity.artifacts", descriptionKey: "shell.activity.artifactsDescription", adapter: "unavailable" },
  { id: "memory", labelKey: "shell.activity.memory", descriptionKey: "shell.activity.memoryDescription", adapter: "settings", settingsSection: "memory" },
  { id: "providers", labelKey: "shell.activity.providers", descriptionKey: "shell.activity.providersDescription", adapter: "settings", settingsSection: "providers" },
] as const;

export function settingsSectionForActivity(id: "capabilities" | "memory" | "providers"): SettingsSectionId {
  return ACTIVITY_REGISTRY.find((item) => item.id === id)?.settingsSection ?? "model";
}
