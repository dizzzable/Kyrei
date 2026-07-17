/**
 * Browser / subscription-style auth scaffold (experimental).
 *
 * Gated by experimental.features.browserSubscriptionAuth.
 * This module does NOT implement vendor ToS bypass or Codex impersonation.
 * It provides:
 * - public session state machine
 * - secret token vault (access/refresh never leave secrets store)
 * - manual token bind (operator pastes a token they obtained themselves)
 * - pluggable adapter hook for a future official authorize URL flow
 * - credential resolution into provider apiKey for runtime
 *
 * Company mode / locked experimental gate → all operations fail closed.
 */

import {
  assertExperimentalFeatureEnabled,
  isExperimentalFeatureEnabled,
} from "./experimental-features.js";
import {
  normalizeDeviceFlowRegistration,
  pollDeviceToken,
  requestDeviceAuthorization,
} from "./browser-subscription-device-flow.js";

export const BROWSER_SUBSCRIPTION_FEATURE_ID = "browserSubscriptionAuth";

export const BROWSER_SUBSCRIPTION_SESSION_STATUSES = Object.freeze([
  "awaiting_browser",
  "pending_token",
  "ready",
  "failed",
  "revoked",
]);

export const BROWSER_SUBSCRIPTION_FLOWS = Object.freeze(["manual", "device"]);

/** Catalog of experimental vendor slots (scaffold — not official OAuth clients). */
export const BROWSER_SUBSCRIPTION_VENDORS = Object.freeze([
  {
    id: "openai-chatgpt",
    label: "OpenAI / ChatGPT-style (experimental)",
    protocol: "openai-responses",
    defaultBaseURL: "https://api.openai.com/v1",
    docsHint: "Prefer platform API keys. Device flow needs YOUR registered OAuth client_id + endpoints.",
    supportsDeviceFlow: true,
  },
  {
    id: "anthropic-claude",
    label: "Anthropic / Claude-style (experimental)",
    protocol: "anthropic-messages",
    defaultBaseURL: "https://api.anthropic.com",
    docsHint: "Prefer official API keys. Device flow only with YOUR OAuth app registration.",
    supportsDeviceFlow: true,
  },
  {
    id: "custom-openai-compatible",
    label: "Custom OpenAI-compatible (experimental)",
    protocol: "openai-chat",
    defaultBaseURL: "https://api.openai.com/v1",
    docsHint: "Paste a token or run RFC 8628 device flow against endpoints you control.",
    supportsDeviceFlow: true,
  },
]);

const MAX_SESSIONS = 32;
const MAX_PROFILES = 24;
const MAX_LABEL = 120;
const SESSION_ID_RE = /^bs_[a-z0-9]{8,32}$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VENDOR_IDS = new Set(BROWSER_SUBSCRIPTION_VENDORS.map((v) => v.id));

export class BrowserSubscriptionAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "BrowserSubscriptionAuthError";
    this.code = code;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, max = 256) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  return candidate && candidate.length <= max && !candidate.includes("\0") ? candidate : "";
}

function safeIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date().toISOString();
}

function newSessionId() {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `bs_${Buffer.from(bytes).toString("hex").slice(0, 16)}`;
}

export function listBrowserSubscriptionVendors() {
  return BROWSER_SUBSCRIPTION_VENDORS.map((vendor) => ({ ...vendor }));
}

export function getBrowserSubscriptionVendor(vendorId) {
  return BROWSER_SUBSCRIPTION_VENDORS.find((vendor) => vendor.id === vendorId) ?? null;
}

/**
 * Public config slice (no tokens / no client secrets).
 * @param {unknown} raw
 * @param {{ profileSecrets?: Record<string, { clientSecret?: string }> }} [options]
 */
export function normalizeBrowserSubscriptionPublicConfig(raw, options = {}) {
  const source = object(raw);
  const rows = Array.isArray(source.sessions) ? source.sessions : [];
  const sessions = [];
  const seen = new Set();
  for (const row of rows.slice(0, MAX_SESSIONS)) {
    const session = normalizePublicSession(row);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  const profileSecrets = object(options.profileSecrets);
  const profileRows = Array.isArray(source.profiles) ? source.profiles : [];
  const profiles = [];
  const seenProfiles = new Set();
  for (const row of profileRows.slice(0, MAX_PROFILES)) {
    const profile = normalizePublicDeviceFlowProfile(row, {
      hasClientSecret: Boolean(text(object(profileSecrets[row?.id]).clientSecret, 2_048)),
    });
    if (!profile || seenProfiles.has(profile.id)) continue;
    seenProfiles.add(profile.id);
    profiles.push(profile);
  }
  const activeProfileId = text(source.activeProfileId, 64).toLowerCase();
  return {
    version: 1,
    sessions,
    profiles,
    ...(activeProfileId && seenProfiles.has(activeProfileId) ? { activeProfileId } : {}),
  };
}

function normalizePublicDeviceFlowProfile(value, { hasClientSecret = false } = {}) {
  const source = object(value);
  const id = text(source.id, 64).toLowerCase();
  if (!PROFILE_ID_RE.test(id)) return null;
  const vendorId = text(source.vendorId, 64);
  if (vendorId && !VENDOR_IDS.has(vendorId)) return null;
  const label = text(source.label, MAX_LABEL) || id;
  const clientId = text(source.clientId, 512);
  const deviceAuthorizationEndpoint = text(source.deviceAuthorizationEndpoint, 2_048);
  const tokenEndpoint = text(source.tokenEndpoint, 2_048);
  if (!clientId || !deviceAuthorizationEndpoint || !tokenEndpoint) return null;
  // Soft URL shape check without throwing (import-tolerant).
  for (const url of [deviceAuthorizationEndpoint, tokenEndpoint]) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  const scope = text(source.scope, 512);
  const updatedAt = safeIso(source.updatedAt) || nowIso();
  return {
    id,
    label,
    ...(vendorId ? { vendorId } : {}),
    clientId,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    ...(scope ? { scope } : {}),
    hasClientSecret: hasClientSecret || source.hasClientSecret === true,
    updatedAt,
  };
}

function normalizePublicSession(value) {
  const source = object(value);
  const id = text(source.id, 40).toLowerCase();
  if (!SESSION_ID_RE.test(id)) return null;
  const vendorId = text(source.vendorId, 64);
  if (!VENDOR_IDS.has(vendorId)) return null;
  const status = BROWSER_SUBSCRIPTION_SESSION_STATUSES.includes(source.status)
    ? source.status
    : "pending_token";
  const flow = BROWSER_SUBSCRIPTION_FLOWS.includes(source.flow) ? source.flow : "manual";
  const label = text(source.label, MAX_LABEL) || vendorId;
  const providerId = text(source.providerId, 64).toLowerCase() || null;
  const updatedAt = safeIso(source.updatedAt) || nowIso();
  const createdAt = safeIso(source.createdAt) || updatedAt;
  const errorCode = typeof source.errorCode === "string"
    && /^[a-z][a-z0-9_]{0,80}$/.test(source.errorCode)
    ? source.errorCode
    : null;
  const authorizeHost = text(source.authorizeHost, 253) || null;
  const userCode = text(source.userCode, 128);
  const verificationUri = text(source.verificationUri, 2_048);
  const verificationUriComplete = text(source.verificationUriComplete, 2_048);
  const deviceExpiresAt = safeIso(source.deviceExpiresAt);
  const pollIntervalSec = Number(source.pollIntervalSec);
  return {
    id,
    vendorId,
    label,
    status,
    flow,
    providerId,
    createdAt,
    updatedAt,
    ...(errorCode ? { errorCode } : {}),
    ...(authorizeHost ? { authorizeHost } : {}),
    ...(userCode ? { userCode } : {}),
    ...(verificationUri ? { verificationUri } : {}),
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    ...(deviceExpiresAt ? { deviceExpiresAt } : {}),
    ...(Number.isFinite(pollIntervalSec) && pollIntervalSec > 0
      ? { pollIntervalSec: Math.min(120, Math.floor(pollIntervalSec)) }
      : {}),
    hasStoredToken: source.hasStoredToken === true || status === "ready",
  };
}

/**
 * Secret vault for browser-subscription sessions + device-flow profile secrets.
 * Keeps access tokens, device_code, and profile clientSecret (never public).
 * @param {unknown} raw from secrets.browserSubscription
 */
export function normalizeBrowserSubscriptionSecrets(raw) {
  const source = object(raw);
  const sessions = {};
  for (const [id, row] of Object.entries(object(source.sessions))) {
    if (!SESSION_ID_RE.test(id)) continue;
    const entry = object(row);
    const accessToken = text(entry.accessToken, 20_000);
    const refreshToken = text(entry.refreshToken, 20_000);
    const expiresAt = safeIso(entry.expiresAt);
    const deviceCode = text(entry.deviceCode, 2_048);
    const clientId = text(entry.clientId, 512);
    const clientSecret = text(entry.clientSecret, 2_048);
    const tokenEndpoint = text(entry.tokenEndpoint, 2_048);
    const scope = text(entry.scope, 512);
    if (!accessToken && !deviceCode) continue;
    sessions[id] = {
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(deviceCode ? { deviceCode } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      ...(scope ? { scope } : {}),
    };
  }
  const profiles = {};
  for (const [id, row] of Object.entries(object(source.profiles))) {
    if (!PROFILE_ID_RE.test(id)) continue;
    const clientSecret = text(object(row).clientSecret, 2_048);
    if (!clientSecret) continue;
    profiles[id] = { clientSecret };
  }
  return { sessions, profiles };
}

/**
 * Upsert a reusable device-flow connection profile.
 * Public fields: endpoints + clientId. clientSecret stays in secrets.profiles.
 */
export function upsertBrowserSubscriptionDeviceProfile(config, secrets, input = {}, options = {}) {
  assertBrowserSubscriptionAllowed(config);
  const vault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription, {
    profileSecrets: vault.profiles,
  });

  let id = text(input.id, 64).toLowerCase();
  if (!id) {
    id = `dfp_${Buffer.from(cryptoGetRandom(6)).toString("hex")}`;
  }
  if (!PROFILE_ID_RE.test(id)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_profile_id_invalid");
  }
  if (publicCfg.profiles.length >= MAX_PROFILES && !publicCfg.profiles.some((p) => p.id === id)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_profile_limit");
  }

  const registration = normalizeDeviceFlowRegistration({
    clientId: input.clientId,
    deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint ?? input.deviceAuthUrl,
    tokenEndpoint: input.tokenEndpoint ?? input.tokenUrl,
    scope: input.scope,
    clientSecret: input.clientSecret,
  });

  const vendorId = text(input.vendorId, 64);
  if (vendorId && !VENDOR_IDS.has(vendorId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_vendor_invalid");
  }
  const label = text(input.label, MAX_LABEL) || id;
  const stamp = nowIso(options.now);
  const clearSecret = input.clearClientSecret === true;
  const nextSecret = text(input.clientSecret, 2_048);
  const existingSecret = vault.profiles[id]?.clientSecret || "";

  const profile = normalizePublicDeviceFlowProfile({
    id,
    label,
    vendorId,
    clientId: registration.clientId,
    deviceAuthorizationEndpoint: registration.deviceAuthorizationEndpoint,
    tokenEndpoint: registration.tokenEndpoint,
    scope: registration.scope,
    updatedAt: stamp,
    hasClientSecret: Boolean(nextSecret || (!clearSecret && existingSecret)),
  });
  if (!profile) throw new BrowserSubscriptionAuthError("browser_subscription_profile_invalid");

  const profiles = [...publicCfg.profiles.filter((row) => row.id !== id), profile]
    .sort((a, b) => a.label.localeCompare(b.label));
  const nextVault = {
    sessions: vault.sessions,
    profiles: { ...vault.profiles },
  };
  if (clearSecret) delete nextVault.profiles[id];
  else if (nextSecret) nextVault.profiles[id] = { clientSecret: nextSecret };
  // else keep existing secret

  return {
    config: {
      version: 1,
      sessions: publicCfg.sessions,
      profiles,
      activeProfileId: id,
    },
    secrets: nextVault,
    profile: {
      ...profile,
      hasClientSecret: Boolean(nextVault.profiles[id]?.clientSecret),
    },
  };
}

export function deleteBrowserSubscriptionDeviceProfile(config, secrets, profileIdInput) {
  assertBrowserSubscriptionAllowed(config);
  const profileId = text(profileIdInput, 64).toLowerCase();
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_profile_id_invalid");
  }
  const vault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription, {
    profileSecrets: vault.profiles,
  });
  const profiles = publicCfg.profiles.filter((row) => row.id !== profileId);
  const nextVault = {
    sessions: vault.sessions,
    profiles: { ...vault.profiles },
  };
  delete nextVault.profiles[profileId];
  return {
    config: {
      version: 1,
      sessions: publicCfg.sessions,
      profiles,
      ...(publicCfg.activeProfileId === profileId ? {} : {
        ...(publicCfg.activeProfileId ? { activeProfileId: publicCfg.activeProfileId } : {}),
      }),
    },
    secrets: nextVault,
  };
}

export function setActiveBrowserSubscriptionDeviceProfile(config, profileIdInput) {
  assertBrowserSubscriptionAllowed(config);
  const profileId = text(profileIdInput, 64).toLowerCase();
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  if (profileId && !publicCfg.profiles.some((row) => row.id === profileId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_profile_not_found");
  }
  return {
    version: 1,
    sessions: publicCfg.sessions,
    profiles: publicCfg.profiles,
    ...(profileId ? { activeProfileId: profileId } : {}),
  };
}

function cryptoGetRandom(n) {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** Keep durable profiles when mutating only sessions. */
function publicConfigWithSessions(publicCfg, sessions) {
  return {
    version: 1,
    sessions,
    profiles: publicCfg.profiles ?? [],
    ...(publicCfg.activeProfileId ? { activeProfileId: publicCfg.activeProfileId } : {}),
  };
}

function vaultWithSessions(vault, sessions) {
  return {
    sessions,
    profiles: { ...(vault.profiles ?? {}) },
  };
}

/**
 * Resolve device-flow registration from a saved profile + optional overrides.
 */
export function resolveDeviceFlowRegistrationFromProfile(config, secrets, profileId, overrides = {}) {
  const vault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription, {
    profileSecrets: vault.profiles,
  });
  const profile = publicCfg.profiles.find((row) => row.id === text(profileId, 64).toLowerCase());
  if (!profile) throw new BrowserSubscriptionAuthError("browser_subscription_profile_not_found");
  const secret = vault.profiles[profile.id]?.clientSecret || "";
  return normalizeDeviceFlowRegistration({
    clientId: overrides.clientId || profile.clientId,
    deviceAuthorizationEndpoint: overrides.deviceAuthorizationEndpoint
      || overrides.deviceAuthUrl
      || profile.deviceAuthorizationEndpoint,
    tokenEndpoint: overrides.tokenEndpoint || overrides.tokenUrl || profile.tokenEndpoint,
    scope: overrides.scope !== undefined ? overrides.scope : profile.scope,
    clientSecret: overrides.clientSecret !== undefined ? overrides.clientSecret : secret,
  });
}

export function assertBrowserSubscriptionAllowed(config) {
  try {
    assertExperimentalFeatureEnabled(config, BROWSER_SUBSCRIPTION_FEATURE_ID);
  } catch {
    throw new BrowserSubscriptionAuthError(
      "browser_subscription_feature_disabled",
      "Browser/subscription auth requires experimental unlock + feature toggle",
    );
  }
}

export function isBrowserSubscriptionAllowed(config) {
  return isExperimentalFeatureEnabled(config, BROWSER_SUBSCRIPTION_FEATURE_ID);
}

/**
 * Start a new experimental session.
 * - manual (default): pending_token → paste access token
 * - device: RFC 8628 with operator-supplied client_id + endpoints
 * - options.adapter.startAuthorize: optional custom authorize URL adapter
 */
export async function startBrowserSubscriptionSession(config, secrets, input = {}, options = {}) {
  assertBrowserSubscriptionAllowed(config);
  const vendorId = text(input.vendorId, 64);
  const vendor = getBrowserSubscriptionVendor(vendorId);
  if (!vendor) throw new BrowserSubscriptionAuthError("browser_subscription_vendor_invalid");

  const vault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  const basePublic = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription, {
    profileSecrets: vault.profiles,
  });
  if (basePublic.sessions.length >= MAX_SESSIONS) {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_limit");
  }

  const id = newSessionId();
  const stamp = nowIso(options.now);
  const label = text(input.label, MAX_LABEL) || vendor.label;
  const providerId = text(input.providerId, 64).toLowerCase() || null;
  const wantDevice = input.flow === "device"
    || input.deviceFlow === true
    || (input.deviceFlow && typeof input.deviceFlow === "object")
    || Boolean(text(input.profileId, 64));

  const nextSecrets = {
    sessions: { ...vault.sessions },
    profiles: { ...vault.profiles },
  };
  let session;
  let nextStep = "paste_access_token";
  let activeProfileId = basePublic.activeProfileId;

  if (wantDevice) {
    const profileId = text(input.profileId, 64).toLowerCase();
    let registration;
    if (profileId) {
      registration = resolveDeviceFlowRegistrationFromProfile(
        config,
        secrets,
        profileId,
        input.deviceFlow && typeof input.deviceFlow === "object" ? input.deviceFlow : {},
      );
      activeProfileId = profileId;
    } else {
      registration = normalizeDeviceFlowRegistration(
        input.deviceFlow && typeof input.deviceFlow === "object" ? input.deviceFlow : input,
      );
    }
    const fetchImpl = typeof options.fetch === "function"
      ? options.fetch
      : globalThis.fetch.bind(globalThis);
    const device = await requestDeviceAuthorization(registration, fetchImpl);
    let authorizeHost = null;
    try {
      authorizeHost = new URL(device.verificationUri).host;
    } catch {
      /* ignore */
    }
    const deviceExpiresAt = new Date(
      Date.parse(stamp) + device.expiresIn * 1_000,
    ).toISOString();
    session = normalizePublicSession({
      id,
      vendorId,
      label,
      status: "awaiting_browser",
      flow: "device",
      providerId,
      createdAt: stamp,
      updatedAt: stamp,
      hasStoredToken: false,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      ...(device.verificationUriComplete
        ? { verificationUriComplete: device.verificationUriComplete }
        : {}),
      deviceExpiresAt,
      pollIntervalSec: device.interval,
      ...(authorizeHost ? { authorizeHost } : {}),
    });
    nextSecrets.sessions[id] = {
      deviceCode: device.deviceCode,
      clientId: registration.clientId,
      tokenEndpoint: registration.tokenEndpoint,
      ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
      ...(registration.scope ? { scope: registration.scope } : {}),
    };
    nextStep = "open_verification_uri";
  } else {
    // Optional custom adapter (sync or async).
    const adapter = options.adapter;
    let authorizeHost = null;
    let status = "pending_token";
    let verificationUri = "";
    if (adapter && typeof adapter.startAuthorize === "function") {
      const started = await Promise.resolve(adapter.startAuthorize({ vendorId, sessionId: id }));
      if (started?.authorizeUrl && typeof started.authorizeUrl === "string") {
        try {
          const url = new URL(started.authorizeUrl);
          if (url.protocol === "https:") {
            authorizeHost = url.host;
            verificationUri = url.href;
            status = "awaiting_browser";
            nextStep = "open_authorize_url";
          }
        } catch {
          /* ignore bad adapter URL */
        }
      }
    }
    session = normalizePublicSession({
      id,
      vendorId,
      label,
      status,
      flow: "manual",
      providerId,
      createdAt: stamp,
      updatedAt: stamp,
      hasStoredToken: false,
      ...(authorizeHost ? { authorizeHost } : {}),
      ...(verificationUri ? { verificationUri } : {}),
    });
  }

  const nextPublic = {
    version: 1,
    sessions: [...basePublic.sessions, session],
    profiles: basePublic.profiles,
    ...(activeProfileId ? { activeProfileId } : {}),
  };
  return {
    config: nextPublic,
    secrets: nextSecrets,
    session,
    nextStep,
  };
}

/**
 * Poll RFC 8628 token endpoint for an awaiting device session.
 */
export async function pollBrowserSubscriptionDeviceSession(config, secrets, sessionIdInput, options = {}) {
  assertBrowserSubscriptionAllowed(config);
  const sessionId = text(sessionIdInput, 40).toLowerCase();
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_invalid");
  }
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  const index = publicCfg.sessions.findIndex((row) => row.id === sessionId);
  if (index < 0) throw new BrowserSubscriptionAuthError("browser_subscription_session_not_found");
  const current = publicCfg.sessions[index];
  if (current.flow !== "device") {
    throw new BrowserSubscriptionAuthError("browser_subscription_not_device_flow");
  }
  if (current.status === "ready") {
    return {
      config: publicCfg,
      secrets: normalizeBrowserSubscriptionSecrets(secrets.browserSubscription),
      session: current,
      pollStatus: "ready",
    };
  }
  if (current.status === "revoked" || current.status === "failed") {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_terminal");
  }

  const vault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  const material = vault.sessions[sessionId];
  if (!material?.deviceCode || !material.clientId || !material.tokenEndpoint) {
    throw new BrowserSubscriptionAuthError("browser_subscription_device_material_missing");
  }

  if (current.deviceExpiresAt) {
    const exp = Date.parse(current.deviceExpiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      const stamp = nowIso(options.now);
      const nextSessions = [...publicCfg.sessions];
      nextSessions[index] = {
        ...current,
        status: "failed",
        errorCode: "oauth_expired_token",
        updatedAt: stamp,
      };
      const nextVault = vaultWithSessions(vault, { ...vault.sessions });
      delete nextVault.sessions[sessionId];
      return {
        config: publicConfigWithSessions(publicCfg, nextSessions),
        secrets: nextVault,
        session: nextSessions[index],
        pollStatus: "failed",
      };
    }
  }

  const fetchImpl = typeof options.fetch === "function"
    ? options.fetch
    : globalThis.fetch.bind(globalThis);
  const result = await pollDeviceToken(
    {
      clientId: material.clientId,
      tokenEndpoint: material.tokenEndpoint,
      ...(material.clientSecret ? { clientSecret: material.clientSecret } : {}),
    },
    material.deviceCode,
    fetchImpl,
  );

  const stamp = nowIso(options.now);
  const nextSessions = [...publicCfg.sessions];
  const nextVault = vaultWithSessions(vault, { ...vault.sessions });

  if (result.status === "ready") {
    const expiresAt = result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1_000).toISOString()
      : undefined;
    nextSessions[index] = {
      ...current,
      status: "ready",
      updatedAt: stamp,
      hasStoredToken: true,
      errorCode: undefined,
    };
    delete nextSessions[index].errorCode;
    nextVault.sessions[sessionId] = {
      accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    return {
      config: publicConfigWithSessions(publicCfg, nextSessions),
      secrets: nextVault,
      session: nextSessions[index],
      pollStatus: "ready",
    };
  }

  if (result.status === "slow_down" || result.status === "pending") {
    const interval = result.interval
      ?? (result.status === "slow_down" ? Math.max(10, (current.pollIntervalSec ?? 5) + 5) : current.pollIntervalSec);
    nextSessions[index] = {
      ...current,
      status: "awaiting_browser",
      updatedAt: stamp,
      ...(interval ? { pollIntervalSec: interval } : {}),
    };
    return {
      config: publicConfigWithSessions(publicCfg, nextSessions),
      secrets: nextVault,
      session: nextSessions[index],
      pollStatus: result.status,
    };
  }

  nextSessions[index] = {
    ...current,
    status: "failed",
    errorCode: result.errorCode || "browser_subscription_device_poll_failed",
    updatedAt: stamp,
  };
  delete nextVault.sessions[sessionId];
  return {
    config: publicConfigWithSessions(publicCfg, nextSessions),
    secrets: nextVault,
    session: nextSessions[index],
    pollStatus: "failed",
  };
}

/**
 * Bind a token the operator obtained themselves (scaffold / interim path).
 */
export function bindBrowserSubscriptionToken(config, secrets, input = {}, options = {}) {
  assertBrowserSubscriptionAllowed(config);
  const sessionId = text(input.sessionId, 40).toLowerCase();
  const accessToken = text(input.accessToken, 20_000);
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_invalid");
  }
  if (!accessToken) {
    throw new BrowserSubscriptionAuthError("browser_subscription_token_required");
  }

  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  const index = publicCfg.sessions.findIndex((row) => row.id === sessionId);
  if (index < 0) throw new BrowserSubscriptionAuthError("browser_subscription_session_not_found");

  const stamp = nowIso(options.now);
  const refreshToken = text(input.refreshToken, 20_000);
  const expiresAt = safeIso(input.expiresAt);
  const nextSessions = [...publicCfg.sessions];
  nextSessions[index] = {
    ...nextSessions[index],
    status: "ready",
    updatedAt: stamp,
    hasStoredToken: true,
    errorCode: undefined,
  };
  // Drop errorCode if present
  delete nextSessions[index].errorCode;

  const nextSecrets = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  nextSecrets.sessions[sessionId] = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };

  return {
    config: publicConfigWithSessions(publicCfg, nextSessions),
    secrets: nextSecrets,
    session: nextSessions[index],
  };
}

export function revokeBrowserSubscriptionSession(config, secrets, sessionIdInput, options = {}) {
  // Revoke is allowed even if feature later disabled — operator must be able to clear risk.
  const sessionId = text(sessionIdInput, 40).toLowerCase();
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_invalid");
  }
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  const stamp = nowIso(options.now);
  const nextSessions = publicCfg.sessions.map((row) => (
    row.id === sessionId
      ? { ...row, status: "revoked", updatedAt: stamp, hasStoredToken: false }
      : row
  ));
  const nextSecrets = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  delete nextSecrets.sessions[sessionId];
  return {
    config: publicConfigWithSessions(publicCfg, nextSessions),
    secrets: nextSecrets,
    session: nextSessions.find((row) => row.id === sessionId) ?? null,
  };
}

export function deleteBrowserSubscriptionSession(config, secrets, sessionIdInput) {
  const sessionId = text(sessionIdInput, 40).toLowerCase();
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_invalid");
  }
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  const nextSessions = publicCfg.sessions.filter((row) => row.id !== sessionId);
  const nextSecrets = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  delete nextSecrets.sessions[sessionId];
  return {
    config: publicConfigWithSessions(publicCfg, nextSessions),
    secrets: nextSecrets,
  };
}

/**
 * Link a ready session to a provider id (public metadata only).
 */
export function linkBrowserSubscriptionProvider(config, sessionIdInput, providerIdInput) {
  assertBrowserSubscriptionAllowed(config);
  const sessionId = text(sessionIdInput, 40).toLowerCase();
  const providerId = text(providerIdInput, 64).toLowerCase();
  if (!SESSION_ID_RE.test(sessionId) || !providerId) {
    throw new BrowserSubscriptionAuthError("browser_subscription_link_invalid");
  }
  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  const nextSessions = publicCfg.sessions.map((row) => (
    row.id === sessionId
      ? { ...row, providerId, updatedAt: nowIso() }
      : row
  ));
  if (!nextSessions.some((row) => row.id === sessionId)) {
    throw new BrowserSubscriptionAuthError("browser_subscription_session_not_found");
  }
  return {
    version: 1,
    sessions: nextSessions,
    profiles: publicCfg.profiles,
    ...(publicCfg.activeProfileId ? { activeProfileId: publicCfg.activeProfileId } : {}),
  };
}

/**
 * Resolve bearer credentials for a provider that uses browser-subscription source.
 * @returns {{ apiKey: string, sessionId: string } | null}
 */
export function resolveBrowserSubscriptionCredentials(config, secrets, provider) {
  if (!provider || provider.credentialSource !== "browser-subscription") return null;
  if (!isBrowserSubscriptionAllowed(config)) return null;

  const publicCfg = normalizeBrowserSubscriptionPublicConfig(config.browserSubscription);
  const secretVault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  const linkedId = text(provider.browserSubscriptionSessionId, 40).toLowerCase();

  const candidates = publicCfg.sessions.filter((row) => {
    if (row.status !== "ready") return false;
    if (linkedId && row.id === linkedId) return true;
    if (!linkedId && row.providerId === provider.id) return true;
    return false;
  });
  const session = candidates[0];
  if (!session) return null;
  const material = secretVault.sessions[session.id];
  if (!material?.accessToken) return null;
  if (material.expiresAt) {
    const exp = Date.parse(material.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) return null;
  }
  return { apiKey: material.accessToken, sessionId: session.id };
}

/** Normalize provider public fields related to this auth source. */
export function normalizeProviderCredentialSource(value, { featureEnabled = false } = {}) {
  const source = text(value, 32).toLowerCase();
  if (source === "browser-subscription" && featureEnabled) return "browser-subscription";
  return "api-key";
}

export function publicBrowserSubscriptionSnapshot(config, secrets = {}) {
  const vault = normalizeBrowserSubscriptionSecrets(secrets.browserSubscription);
  return {
    allowed: isBrowserSubscriptionAllowed(config),
    vendors: listBrowserSubscriptionVendors(),
    ...normalizeBrowserSubscriptionPublicConfig(config.browserSubscription, {
      profileSecrets: vault.profiles,
    }),
  };
}
