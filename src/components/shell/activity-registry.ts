import type { enShell } from "@/i18n/locales/en/shell";
import type { SettingsSectionId } from "@/components/settings/settings-registry";

export type ActivityId = "sessions" | "capabilities" | "messaging" | "artifacts" | "memory" | "providers";
export type ShellTranslationKey = Extract<keyof typeof enShell, string>;
export type ActivityAdapter = "sessions" | "settings" | "missions" | "unavailable";

export interface ActivityDefinition {
  id: ActivityId;
  labelKey: ShellTranslationKey;
  descriptionKey: ShellTranslationKey;
  adapter: ActivityAdapter;
  settingsSection?: SettingsSectionId;
}

export const ACTIVITY_REGISTRY: readonly ActivityDefinition[] = [
  { id: "sessions", labelKey: "shell.activity.sessions", descriptionKey: "shell.activity.sessionsDescription", adapter: "sessions" },
  { id: "capabilities", labelKey: "shell.activity.capabilities", descriptionKey: "shell.activity.capabilitiesDescription", adapter: "settings", settingsSection: "skills" },
  /** Local alerts / voice — external Slack/Telegram remain optional product work. */
  { id: "messaging", labelKey: "shell.activity.messaging", descriptionKey: "shell.activity.messagingDescription", adapter: "settings", settingsSection: "notifications" },
  /** Pipeline mission artifacts / department envelopes — real connected surface. */
  { id: "artifacts", labelKey: "shell.activity.artifacts", descriptionKey: "shell.activity.artifactsDescription", adapter: "missions" },
  { id: "memory", labelKey: "shell.activity.memory", descriptionKey: "shell.activity.memoryDescription", adapter: "settings", settingsSection: "memory" },
  { id: "providers", labelKey: "shell.activity.providers", descriptionKey: "shell.activity.providersDescription", adapter: "settings", settingsSection: "providers" },
] as const;

export function settingsSectionForActivity(
  id: "capabilities" | "memory" | "providers" | "messaging",
): SettingsSectionId {
  return ACTIVITY_REGISTRY.find((item) => item.id === id)?.settingsSection ?? "model";
}

export function activityById(id: ActivityId): ActivityDefinition | undefined {
  return ACTIVITY_REGISTRY.find((item) => item.id === id);
}
