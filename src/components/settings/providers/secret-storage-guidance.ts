import type { TranslationKey } from "@/i18n";
import type { DesktopPlatform } from "@/lib/desktop";

export interface SecretStorageGuidance {
  step1: TranslationKey;
  step2: TranslationKey;
  /** Install / session commands shown under the steps (Linux only today). */
  commands: TranslationKey[];
  /** Extra non-numbered hint (e.g. pure Wayland WMs). */
  hint?: TranslationKey;
}

export function secretStorageGuidanceFor(platform: DesktopPlatform): SecretStorageGuidance {
  switch (platform) {
    case "linux":
      return {
        step1: "settings.providers.error.secretStorageLinuxStep1",
        step2: "settings.providers.error.secretStorageLinuxStep2",
        commands: [
          "settings.providers.error.secretStorageLinuxArchCommand",
          "settings.providers.error.secretStorageLinuxDebCommand",
          "settings.providers.error.secretStorageLinuxKdeCommand",
        ],
        hint: "settings.providers.error.secretStorageLinuxWaylandHint",
      };
    case "windows":
      return {
        step1: "settings.providers.error.secretStorageStep1",
        step2: "settings.providers.error.secretStorageStep2",
        commands: [],
      };
    case "macos":
      return {
        step1: "settings.providers.error.secretStorageMacosStep1",
        step2: "settings.providers.error.secretStorageMacosStep2",
        commands: [],
      };
    default:
      return {
        step1: "settings.providers.error.secretStorageGenericStep1",
        step2: "settings.providers.error.secretStorageGenericStep2",
        commands: [],
      };
  }
}
