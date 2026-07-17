/**
 * Experimental / at-your-own-risk feature gate.
 *
 * Default product path remains official API keys. Gray-area methods
 * (browser/subscription auth style, unofficial transports, etc.) stay off
 * until the operator explicitly accepts a versioned disclaimer.
 *
 * Company mode (accessControl.requireToken) forces the gate closed so employee
 * pools cannot silently enable experimental auth.
 *
 * Acceptance does not make a method ToS-safe — it records that the operator
 * was warned and accepted responsibility.
 */

export const EXPERIMENTAL_DISCLAIMER_VERSION = "2026-07-17.1";

/** Stable feature ids. New experimental capabilities register here. */
export const EXPERIMENTAL_FEATURE_IDS = Object.freeze([
  "browserSubscriptionAuth",
]);

export const EXPERIMENTAL_ACCEPT_PHRASE = "I ACCEPT RISK";

/**
 * @param {unknown} raw
 * @param {{ companyLocked?: boolean }} [options]
 */
export function normalizeExperimentalConfig(raw, options = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const companyLocked = options.companyLocked === true;

  if (companyLocked) {
    return sealedExperimentalConfig({
      companyLocked: true,
      // Keep prior acceptance metadata for audit, but never unlock under company mode.
      acceptedAt: safeIso(source.acceptedAt),
      acceptedDisclaimerVersion: safeVersion(source.acceptedDisclaimerVersion),
    });
  }

  const acceptedDisclaimerVersion = safeVersion(source.acceptedDisclaimerVersion);
  const acceptedAt = safeIso(source.acceptedAt);
  const versionMatches = acceptedDisclaimerVersion === EXPERIMENTAL_DISCLAIMER_VERSION;
  const unlocked = source.unlocked === true
    && Boolean(acceptedAt)
    && versionMatches;

  const features = {};
  for (const id of EXPERIMENTAL_FEATURE_IDS) {
    const requested = source.features
      && typeof source.features === "object"
      && !Array.isArray(source.features)
      && source.features[id] === true;
    // Features only stick when the gate is unlocked with the current disclaimer.
    features[id] = unlocked && requested;
  }

  return {
    unlocked,
    acceptedAt: unlocked || acceptedAt ? acceptedAt : null,
    acceptedDisclaimerVersion: unlocked || versionMatches
      ? (acceptedDisclaimerVersion || null)
      : (acceptedDisclaimerVersion || null),
    companyLocked: false,
    disclaimerVersion: EXPERIMENTAL_DISCLAIMER_VERSION,
    features,
  };
}

/**
 * Accept current disclaimer and unlock the experimental panel.
 * @param {unknown} current
 * @param {{ acceptPhrase?: string, now?: () => Date }} [options]
 */
export function acceptExperimentalDisclaimer(current, options = {}) {
  const phrase = typeof options.acceptPhrase === "string" ? options.acceptPhrase.trim() : "";
  if (phrase !== EXPERIMENTAL_ACCEPT_PHRASE) {
    const error = new Error("experimental_accept_phrase_mismatch");
    error.code = "experimental_accept_phrase_mismatch";
    throw error;
  }
  const now = typeof options.now === "function" ? options.now() : new Date();
  const acceptedAt = now instanceof Date ? now.toISOString() : new Date().toISOString();
  return normalizeExperimentalConfig({
    unlocked: true,
    acceptedAt,
    acceptedDisclaimerVersion: EXPERIMENTAL_DISCLAIMER_VERSION,
    features: object(current).features,
  });
}

/**
 * Revoke acceptance and force every experimental feature off.
 * @param {unknown} current
 */
export function revokeExperimentalDisclaimer(current) {
  const source = object(current);
  return normalizeExperimentalConfig({
    unlocked: false,
    acceptedAt: null,
    acceptedDisclaimerVersion: null,
    features: Object.fromEntries(EXPERIMENTAL_FEATURE_IDS.map((id) => [id, false])),
    // Preserve nothing sensitive — clean revoke.
    ...{},
  });
}

/**
 * @param {unknown} config full app config or experimental slice
 * @param {string} featureId
 * @param {{ companyLocked?: boolean }} [options]
 */
export function isExperimentalFeatureEnabled(config, featureId, options = {}) {
  if (!EXPERIMENTAL_FEATURE_IDS.includes(featureId)) return false;
  const slice = config && typeof config === "object" && "experimental" in config
    ? config.experimental
    : config;
  const companyLocked = options.companyLocked === true
    || (config && typeof config === "object" && config.accessControl?.requireToken === true);
  const normalized = normalizeExperimentalConfig(slice, { companyLocked });
  return normalized.unlocked && normalized.features[featureId] === true;
}

/**
 * Gateway guard: throw if feature is not enabled.
 * @param {unknown} config
 * @param {string} featureId
 */
export function assertExperimentalFeatureEnabled(config, featureId) {
  if (isExperimentalFeatureEnabled(config, featureId)) return;
  const error = new Error(`experimental_feature_disabled:${featureId}`);
  error.code = "experimental_feature_disabled";
  error.featureId = featureId;
  throw error;
}

function sealedExperimentalConfig({
  companyLocked,
  acceptedAt = null,
  acceptedDisclaimerVersion = null,
}) {
  return {
    unlocked: false,
    acceptedAt,
    acceptedDisclaimerVersion,
    companyLocked: Boolean(companyLocked),
    disclaimerVersion: EXPERIMENTAL_DISCLAIMER_VERSION,
    features: Object.fromEntries(EXPERIMENTAL_FEATURE_IDS.map((id) => [id, false])),
  };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function safeVersion(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().slice(0, 64);
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(candidate) ? candidate : null;
}
