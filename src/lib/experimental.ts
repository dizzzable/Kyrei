import type { AppConfig, ExperimentalConfig, ExperimentalFeatureId } from "./types";

/** Must match core/experimental-features.js EXPERIMENTAL_DISCLAIMER_VERSION. */
export const EXPERIMENTAL_DISCLAIMER_VERSION = "2026-07-17.1";

/** Must match core/experimental-features.js EXPERIMENTAL_ACCEPT_PHRASE. */
export const EXPERIMENTAL_ACCEPT_PHRASE = "I ACCEPT RISK";

export const EXPERIMENTAL_FEATURE_IDS: readonly ExperimentalFeatureId[] = [
  "browserSubscriptionAuth",
];

export function emptyExperimentalConfig(): ExperimentalConfig {
  return {
    unlocked: false,
    acceptedAt: null,
    acceptedDisclaimerVersion: null,
    disclaimerVersion: EXPERIMENTAL_DISCLAIMER_VERSION,
    companyLocked: false,
    features: {
      browserSubscriptionAuth: false,
    },
  };
}

export function experimentalFromConfig(config: AppConfig | null | undefined): ExperimentalConfig {
  const raw = config?.experimental;
  const features: ExperimentalConfig["features"] = {};
  for (const id of EXPERIMENTAL_FEATURE_IDS) {
    features[id] = raw?.features?.[id] === true;
  }
  return {
    unlocked: raw?.unlocked === true,
    acceptedAt: typeof raw?.acceptedAt === "string" ? raw.acceptedAt : null,
    acceptedDisclaimerVersion:
      typeof raw?.acceptedDisclaimerVersion === "string" ? raw.acceptedDisclaimerVersion : null,
    disclaimerVersion:
      typeof raw?.disclaimerVersion === "string"
        ? raw.disclaimerVersion
        : EXPERIMENTAL_DISCLAIMER_VERSION,
    companyLocked: raw?.companyLocked === true || config?.accessControl?.requireToken === true,
    features,
  };
}

export function isExperimentalFeatureEnabled(
  config: AppConfig | null | undefined,
  featureId: ExperimentalFeatureId,
): boolean {
  const exp = experimentalFromConfig(config);
  if (exp.companyLocked || !exp.unlocked) return false;
  if (exp.acceptedDisclaimerVersion !== exp.disclaimerVersion) return false;
  return exp.features[featureId] === true;
}

/** Build payload after operator typed the accept phrase. */
export function buildAcceptExperimentalPayload(current: ExperimentalConfig): ExperimentalConfig {
  return {
    ...current,
    unlocked: true,
    acceptedAt: new Date().toISOString(),
    acceptedDisclaimerVersion: current.disclaimerVersion || EXPERIMENTAL_DISCLAIMER_VERSION,
    companyLocked: false,
    features: { ...current.features },
  };
}

export function buildRevokeExperimentalPayload(): ExperimentalConfig {
  return emptyExperimentalConfig();
}

export function buildFeatureTogglePayload(
  current: ExperimentalConfig,
  featureId: ExperimentalFeatureId,
  enabled: boolean,
): ExperimentalConfig {
  return {
    ...current,
    features: {
      ...current.features,
      [featureId]: enabled,
    },
  };
}
