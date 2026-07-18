/** Renderer-safe facade for the official ChatGPT / Codex App Server connector. */

const LOGIN_STATUSES = new Set(["running", "succeeded", "failed", "cancelled", "timed-out"]);
const LOGIN_MODES = new Set(["browser", "device"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,80})?$/;
const SAFE_PLAN = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_AUTH_URL = /^https:\/\/(?:chatgpt\.com|auth\.openai\.com)\//i;
const SAFE_DEVICE_URL = /^https:\/\/auth\.openai\.com\/codex\/device\/?$/i;

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function publicLogin(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (typeof source.id !== "string" || !SAFE_ID.test(source.id)) return null;
  const startedAt = timestamp(source.startedAt);
  const updatedAt = timestamp(source.updatedAt);
  if (startedAt === undefined || updatedAt === undefined) return null;
  const finishedAt = timestamp(source.finishedAt);
  const status = LOGIN_STATUSES.has(source.status) ? source.status : "failed";
  const mode = LOGIN_MODES.has(source.mode) ? source.mode : "browser";
  const authUrl = typeof source.authUrl === "string" && source.authUrl.length <= 8_192 && SAFE_AUTH_URL.test(source.authUrl)
    ? source.authUrl
    : undefined;
  const verificationUrl = typeof source.verificationUrl === "string" && SAFE_DEVICE_URL.test(source.verificationUrl)
    ? source.verificationUrl
    : undefined;
  const userCode = typeof source.userCode === "string" && /^[A-Z0-9-]{4,64}$/i.test(source.userCode)
    ? source.userCode
    : undefined;
  const planType = typeof source.planType === "string" && SAFE_PLAN.test(source.planType) ? source.planType : undefined;
  const error = typeof source.error === "string" && /^codex_app_server_[a-z0-9_]{1,80}$/.test(source.error)
    ? source.error
    : undefined;
  return {
    id: source.id,
    mode,
    status,
    startedAt,
    updatedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(authUrl ? { authUrl } : {}),
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(userCode ? { userCode } : {}),
    ...(planType ? { planType } : {}),
    ...(error ? { error } : {}),
  };
}

function publicStatus(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const installed = source.installed === true;
  const version = installed && typeof source.version === "string" && SAFE_VERSION.test(source.version)
    ? source.version
    : null;
  const authenticated = installed && source.authenticated === true && source.authMode === "chatgpt";
  const planType = authenticated && typeof source.planType === "string" && SAFE_PLAN.test(source.planType)
    ? source.planType
    : null;
  const activeLogin = publicLogin(source.activeLogin);
  const error = typeof source.error === "string" && /^codex_app_server_[a-z0-9_]{1,80}$/.test(source.error)
    ? source.error
    : undefined;
  return {
    installed,
    version,
    authenticated,
    authMode: authenticated ? "chatgpt" : "none",
    planType,
    ...(activeLogin ? { activeLogin } : {}),
    ...(error ? { error } : {}),
  };
}

export function createCodexConnectorApi(connector) {
  const required = ["status", "startLogin", "loginStatus", "cancelLogin", "logout"];
  if (!connector || required.some((name) => typeof connector[name] !== "function")) {
    throw new TypeError("codex-connector-invalid");
  }
  return {
    async status() {
      return publicStatus(await connector.status());
    },
    async startLogin(input) {
      const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const login = publicLogin(await connector.startLogin({
        ...(source.mode !== undefined ? { mode: source.mode } : {}),
      }));
      if (!login) throw new TypeError("codex_app_server_login_invalid");
      return { login };
    },
    loginStatus(id) {
      const login = publicLogin(connector.loginStatus(id));
      if (!login) throw new TypeError("codex_app_server_login_invalid");
      return { login };
    },
    async cancelLogin(id) {
      const login = publicLogin(await connector.cancelLogin(id));
      if (!login) throw new TypeError("codex_app_server_login_invalid");
      return { login };
    },
    async logout() {
      await connector.logout();
      return { loggedOut: true };
    },
    async close() {
      await connector.close?.();
    },
  };
}
