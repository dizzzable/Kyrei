/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) helpers.
 *
 * Used only by experimental browser-subscription auth with operator-supplied
 * client_id + endpoints (their registered app). Kyrei never ships Codex /
 * first-party client secrets.
 */

const MAX_URL = 2_048;
const MAX_CODE = 2_048;
const MAX_SCOPE = 512;

function fail(code, message) {
  const error = new Error(message || code);
  error.name = "BrowserSubscriptionAuthError";
  error.code = code;
  throw error;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertHttpsEndpoint(value, code = "browser_subscription_endpoint_invalid") {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL) {
    fail(code);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail(code);
  }
  if (url.protocol !== "https:") fail(code);
  if (url.username || url.password) fail(code);
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "127.0.0.1"
    || host === "::1"
    || host.endsWith(".local")
  ) {
    fail("browser_subscription_endpoint_private");
  }
  // Block obvious link-local / private IPv4.
  if (/^(10\.|192\.168\.|169\.254\.|127\.)/.test(host)) {
    fail("browser_subscription_endpoint_private");
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    fail("browser_subscription_endpoint_private");
  }
  return url.href;
}

/**
 * Normalize operator-supplied device-flow registration (no secrets in public config).
 * @param {unknown} raw
 */
export function normalizeDeviceFlowRegistration(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const clientId = typeof source.clientId === "string" ? source.clientId.trim() : "";
  if (!clientId || clientId.length > 512 || clientId.includes("\0")) {
    fail("browser_subscription_client_id_invalid");
  }
  const deviceAuthorizationEndpoint = assertHttpsEndpoint(
    source.deviceAuthorizationEndpoint ?? source.deviceAuthUrl,
    "browser_subscription_device_endpoint_invalid",
  );
  const tokenEndpoint = assertHttpsEndpoint(
    source.tokenEndpoint ?? source.tokenUrl,
    "browser_subscription_token_endpoint_invalid",
  );
  const scope = typeof source.scope === "string" && source.scope.trim()
    ? source.scope.trim().slice(0, MAX_SCOPE)
    : "";
  const clientSecret = typeof source.clientSecret === "string" && source.clientSecret.trim()
    ? source.clientSecret.trim().slice(0, 2_048)
    : "";
  return {
    clientId,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    ...(scope ? { scope } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

/**
 * @param {typeof fetch} [fetchImpl]
 */
export async function requestDeviceAuthorization(registration, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const body = new URLSearchParams();
  body.set("client_id", registration.clientId);
  if (registration.scope) body.set("scope", registration.scope);
  // RFC 8628: confidential clients authenticate on the device authorization request too.
  if (registration.clientSecret) body.set("client_secret", registration.clientSecret);

  const response = await fetchImpl(registration.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const payload = await readJsonSafe(response);
  if (!response.ok) {
    const err = new Error(mapOAuthError(payload?.error, "browser_subscription_device_start_failed"));
    err.name = "BrowserSubscriptionAuthError";
    err.code = mapOAuthError(payload?.error, "browser_subscription_device_start_failed");
    err.httpStatus = response.status;
    throw err;
  }

  const deviceCode = textField(payload?.device_code, MAX_CODE);
  const userCode = textField(payload?.user_code, 128);
  const verificationUri = textField(payload?.verification_uri ?? payload?.verification_url, MAX_URL);
  if (!deviceCode || !userCode || !verificationUri) {
    fail("browser_subscription_device_response_invalid");
  }
  // verification_uri must be https public (same rules).
  const safeVerificationUri = assertHttpsEndpoint(
    verificationUri,
    "browser_subscription_verification_uri_invalid",
  );
  let verificationUriComplete = textField(
    payload?.verification_uri_complete ?? payload?.verification_url_complete,
    MAX_URL,
  );
  if (verificationUriComplete) {
    try {
      verificationUriComplete = assertHttpsEndpoint(
        verificationUriComplete,
        "browser_subscription_verification_uri_invalid",
      );
    } catch {
      verificationUriComplete = "";
    }
  }

  const expiresIn = Number(payload?.expires_in);
  const interval = Number(payload?.interval);
  return {
    deviceCode,
    userCode,
    verificationUri: safeVerificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(3_600, Math.floor(expiresIn)) : 600,
    interval: Number.isFinite(interval) && interval > 0 ? Math.min(120, Math.floor(interval)) : 5,
  };
}

/**
 * One token-endpoint poll for a device session.
 * @returns {{ status: 'ready'|'pending'|'slow_down'|'failed', accessToken?, refreshToken?, expiresIn?, errorCode?, interval? }}
 */
export async function pollDeviceToken(registration, deviceCode, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (!deviceCode || typeof deviceCode !== "string") {
    fail("browser_subscription_device_code_missing");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
  body.set("device_code", deviceCode);
  body.set("client_id", registration.clientId);
  if (registration.clientSecret) body.set("client_secret", registration.clientSecret);

  const response = await fetchImpl(registration.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const payload = await readJsonSafe(response);
  if (response.ok && payload?.access_token) {
    const accessToken = textField(payload.access_token, 20_000);
    if (!accessToken) fail("browser_subscription_token_invalid");
    const refreshToken = textField(payload.refresh_token, 20_000);
    const expiresIn = Number(payload.expires_in);
    return {
      status: "ready",
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresIn: Math.min(86_400 * 30, Math.floor(expiresIn)) }
        : {}),
    };
  }

  const oauthError = typeof payload?.error === "string" ? payload.error : "";
  if (oauthError === "authorization_pending" || response.status === 428) {
    return { status: "pending" };
  }
  if (oauthError === "slow_down") {
    return { status: "slow_down", interval: 10 };
  }
  if (oauthError === "expired_token" || oauthError === "access_denied") {
    return {
      status: "failed",
      errorCode: mapOAuthError(oauthError, "browser_subscription_device_denied"),
    };
  }

  return {
    status: "failed",
    errorCode: mapOAuthError(oauthError, "browser_subscription_device_poll_failed"),
  };
}

/** Hosts safe to open via shell.openExternal for device verification pages. */
export const EXPERIMENTAL_AUTH_OPEN_HOSTS = Object.freeze([
  "auth.openai.com",
  "chatgpt.com",
  "platform.openai.com",
  "console.anthropic.com",
  "claude.ai",
  "github.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "oauth.telegram.org",
]);

/**
 * Whether a verification URI may be opened in the system browser.
 * Prefer exact session URI; also allow known OAuth hosts over https.
 */
export function isAllowedExperimentalAuthOpenUrl(url, { sessionVerificationUri } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (sessionVerificationUri) {
    try {
      if (parsed.href === new URL(sessionVerificationUri).href) return true;
    } catch {
      /* fall through */
    }
  }
  const host = parsed.hostname.toLowerCase();
  if (EXPERIMENTAL_AUTH_OPEN_HOSTS.includes(host)) return true;
  // Allow one-level subdomains of allowlisted registrable-style hosts.
  return EXPERIMENTAL_AUTH_OPEN_HOSTS.some((allowed) => host.endsWith(`.${allowed}`));
}

function textField(value, max) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  return candidate && candidate.length <= max && !candidate.includes("\0") ? candidate : "";
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function mapOAuthError(error, fallback) {
  if (typeof error !== "string") return fallback;
  const normalized = error.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 64);
  if (!normalized) return fallback;
  return `oauth_${normalized}`;
}
