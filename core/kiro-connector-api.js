/**
 * Renderer-safe facade for the official Kiro CLI connector.
 *
 * The process adapter already redacts its output, but the gateway still uses
 * an explicit allowlist so a future connector change cannot accidentally
 * serialize identity or credential fields into the renderer.
 */

import { isValidKiroModelId } from "./kiro-cli-connector.js";
import { redactSensitiveText } from "./secret-redaction.js";

const LOGIN_STATUSES = new Set(["running", "succeeded", "failed", "cancelled", "timed-out"]);
const LOGIN_MODES = new Set(["browser", "device"]);
const LOGIN_METHODS = new Set(["unified", "free", "google", "github", "identity-center"]);
const AUTH_METHODS = new Set(["builder-id", "google", "github", "identity-center", "api-key"]);
const ACCOUNT_TYPES = new Set(["free", "enterprise", "api-key"]);
const SAFE_ERROR = /^kiro_cli_[a-z0-9_]{1,80}$/;
const SAFE_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,80})?$/;
const SAFE_LOGIN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PUBLIC_PROGRESS = 16_000;
const MAX_PUBLIC_MODELS = 512;

function integerTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeEnum(value, values, fallback) {
  return typeof value === "string" && values.has(value) ? value : fallback;
}

function publicProgress(value) {
  if (typeof value !== "string") return "";
  return redactSensitiveText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/([?#&](?:access_token|refresh_token|id_token|token|state|code)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:access_token|refresh_token|id_token|token|client_secret|code_verifier)\s*[:=]\s*[^\s,;]+/gi, (match) => (
      `${match.slice(0, match.search(/[:=]/) + 1)} [REDACTED]`
    ))
    .slice(0, MAX_PUBLIC_PROGRESS);
}

export function publicKiroLogin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.id !== "string" || !SAFE_LOGIN_ID.test(value.id)) return null;
  const startedAt = integerTimestamp(value.startedAt);
  const updatedAt = integerTimestamp(value.updatedAt);
  if (startedAt === undefined || updatedAt === undefined) return null;
  const finishedAt = integerTimestamp(value.finishedAt);
  const progress = publicProgress(value.progress);
  const error = typeof value.error === "string" && SAFE_ERROR.test(value.error)
    ? value.error
    : undefined;
  return {
    id: value.id,
    status: safeEnum(value.status, LOGIN_STATUSES, "failed"),
    mode: safeEnum(value.mode, LOGIN_MODES, "browser"),
    method: safeEnum(value.method, LOGIN_METHODS, "unified"),
    startedAt,
    updatedAt,
    progress,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(error ? { error } : {}),
  };
}

function publicCapabilities(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    accountIsolation: source.accountIsolation === "global" ? "global" : "global",
    maxAccounts: 1,
    supportsAccountPool: false,
  };
}

function publicIdentity(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const authenticated = source.authenticated === true;
  const method = authenticated ? safeEnum(source.method, AUTH_METHODS, null) : null;
  const accountType = authenticated ? safeEnum(source.accountType, ACCOUNT_TYPES, null) : null;
  if (!method || !accountType) {
    return { authenticated: false, method: "none", accountType: "none" };
  }
  return {
    authenticated: true,
    method,
    accountType,
  };
}

function publicModels(value) {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_MODELS) {
    const error = new Error("kiro_cli_models_invalid");
    error.code = "kiro_cli_models_invalid";
    throw error;
  }
  const seen = new Set();
  return value.flatMap((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!isValidKiroModelId(id) || seen.has(id)) return [];
    seen.add(id);
    const name = typeof entry?.name === "string" && entry.name.trim() && entry.name.length <= 160
      ? entry.name.trim()
      : id;
    return [{ id, name }];
  });
}

export function createKiroConnectorApi(connector) {
  const required = ["detect", "whoami", "capabilities", "discoverModels", "startLogin", "getLoginStatus", "cancelLogin", "logout"];
  if (!connector || required.some((name) => typeof connector[name] !== "function")) {
    throw new TypeError("kiro-connector-invalid");
  }

  return {
    async status() {
      const detected = await connector.detect();
      const installed = detected?.installed === true;
      const version = installed && typeof detected.version === "string" && SAFE_VERSION.test(detected.version)
        ? detected.version
        : null;
      const identity = installed
        ? publicIdentity(await connector.whoami())
        : publicIdentity(null);
      const activeLogin = typeof connector.activeLogin === "function"
        ? publicKiroLogin(connector.activeLogin())
        : null;
      return {
        installed,
        version,
        ...identity,
        capabilities: publicCapabilities(connector.capabilities()),
        ...(activeLogin ? { activeLogin } : {}),
      };
    },

    async models() {
      const models = publicModels(await connector.discoverModels());
      return { models, count: models.length };
    },

    startLogin(input) {
      const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const login = connector.startLogin({
        ...(source.mode !== undefined ? { mode: source.mode } : {}),
        ...(source.method !== undefined ? { method: source.method } : {}),
        ...(source.identityProvider !== undefined ? { identityProvider: source.identityProvider } : {}),
        ...(source.region !== undefined ? { region: source.region } : {}),
      });
      const result = publicKiroLogin(login);
      if (!result) throw new TypeError("kiro_cli_login_invalid");
      return { login: result };
    },

    loginStatus(id) {
      const login = publicKiroLogin(connector.getLoginStatus(id));
      if (!login) throw new TypeError("kiro_cli_login_invalid");
      return { login };
    },

    cancelLogin(id) {
      const login = publicKiroLogin(connector.cancelLogin(id));
      if (!login) throw new TypeError("kiro_cli_login_invalid");
      return { login };
    },

    async logout() {
      await connector.logout();
      return { loggedOut: true };
    },

    async close() {
      if (typeof connector.close === "function") await connector.close();
      else if (typeof connector.dispose === "function") await connector.dispose();
    },
  };
}
