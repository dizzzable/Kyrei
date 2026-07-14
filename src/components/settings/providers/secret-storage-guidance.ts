import type { TranslationKey } from "@/i18n";
import type { DesktopPlatform } from "@/lib/desktop";

export interface SecretStorageGuidance {
  step1: TranslationKey;
  step2: TranslationKey;
}

export function secretStorageGuidanceFor(platform: DesktopPlatform): SecretStorageGuidance {
  switch (platform) {
    case "linux":
      return {
        step1: "settings.providers.error.secretStorageLinuxStep1",
        step2: "settings.providers.error.secretStorageLinuxStep2",
      };
    case "windows":
      return {
        step1: "settings.providers.error.secretStorageStep1",
        step2: "settings.providers.error.secretStorageStep2",
      };
    case "macos":
      return {
        step1: "settings.providers.error.secretStorageMacosStep1",
        step2: "settings.providers.error.secretStorageMacosStep2",
      };
    default:
      return {
        step1: "settings.providers.error.secretStorageGenericStep1",
        step2: "settings.providers.error.secretStorageGenericStep2",
      };
  }
}
