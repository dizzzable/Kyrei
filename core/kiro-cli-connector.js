/**
 * Secure adapter for the separately installed, official Kiro CLI.
 *
 * Kyrei never reads Kiro credential/cookie files and never calls private Kiro
 * endpoints. Authentication is delegated to an absolute `kiro-cli` binary;
 * this module exposes only bounded, redacted process state.
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { redactSensitiveText } from "./secret-redaction.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_DEVICE_LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 512_000;
const MAX_LOGIN_OUTPUT_BYTES = 256_000;
const MAX_PROGRESS_CHARS = 16_000;
const MAX_PENDING_PROGRESS_LINE = 8_000;
const MAX_LOGIN_RECORDS = 32;
const MAX_MODELS = 512;
const MIN_LOGIN_TIMEOUT_MS = 30_000;
const MAX_LOGIN_TIMEOUT_MS = 30 * 60_000;
const MIN_CLOSE_TIMEOUT_MS = 100;
const MAX_CLOSE_TIMEOUT_MS = 30_000;

const LOGIN_MODES = new Set(["browser", "device"]);
const LOGIN_METHODS = new Set(["unified", "free", "google", "github", "identity-center"]);
const TERMINAL_LOGIN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed-out"]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const REGION_PATTERN = /^(?:af|ap|ca|cn|eu|il|me|mx|sa|us)(?:-gov|-iso|-isob)?-[a-z0-9]+(?:-[a-z0-9]+)*-\d$/;
const ANSI_PATTERN = /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[()[\]#;?]*(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const URL_SECRET_PATTERN = /([?#&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|state|code)=)[^&#\s]*/gi;
const SENSITIVE_KV_PATTERN = /(?<![A-Za-z0-9_])(["']?)(access[_-]?token|refresh[_-]?token|id[_-]?token|device[_-]?code|authorization[_-]?code|api[_-]?key|client[_-]?secret|session[_-]?(?:id|token)?|authorization|password|passwd|secret|cookie|token|state|code)\1(?![A-Za-z0-9_])(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]*)/gi;
const SENSITIVE_HEADER_PATTERN = /\b(authorization|cookie)(\s*:\s*)[^\r\n]*/gi;

const CHILD_ENV_KEYS = new Set([
  "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR",
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_SDK_LOAD_CONFIG",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
const POSIX_LOWERCASE_ENV_KEYS = new Set(["https_proxy", "http_proxy", "all_proxy", "no_proxy"]);
const RESOLUTION_ENV_KEYS = new Set(["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA"]);

export const KIRO_CLI_ACCOUNT_CAPABILITIES = Object.freeze({
  accountIsolation: "global",
  maxAccounts: 1,
  supportsAccountPool: false,
});

// Kiro CLI authentication is user-global. This lock serializes every login
// and logout across all connector instances in this process.
let globalAuthMutation = null;

export class KiroCliConnectorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "KiroCliConnectorError";
    this.code = code;
  }
}

function connectorError(code, message, cause) {
  return new KiroCliConnectorError(code, message, cause ? { cause } : undefined);
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function isLocalAbsolutePath(value, platform) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const api = pathApi(platform);
  if (!api.isAbsolute(value)) return false;
  if (platform === "win32") return !value.startsWith("\\\\") && !value.startsWith("//");
  return !value.startsWith("//");
}

function validateExecutable(value, platform = process.platform) {
  if (!isLocalAbsolutePath(value, platform) || value.length > 1_024) {
    throw connectorError("kiro_cli_executable_invalid", "Kiro CLI executable must be an absolute local path");
  }
  const api = pathApi(platform);
  const normalized = api.normalize(value);
  const base = api.basename(normalized).toLowerCase();
  const allowed = platform === "win32" ? base === "kiro-cli.exe" : base === "kiro-cli";
  if (!allowed) throw connectorError("kiro_cli_executable_invalid", "Kiro CLI executable name is invalid");
  return normalized;
}

function safeEnvironmentValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0");
}

function resolutionEnvironment(source, platform) {
  const result = {};
  for (const [key, value] of Object.entries(source && typeof source === "object" ? source : {})) {
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    if (RESOLUTION_ENV_KEYS.has(normalizedKey) && safeEnvironmentValue(value)) result[normalizedKey] = value;
  }
  return result;
}

/** Build the only environment values inherited by the official CLI child. */
export function buildKiroCliEnvironment(source = process.env, { platform = process.platform } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(source && typeof source === "object" ? source : {})) {
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    const allowed = CHILD_ENV_KEYS.has(normalizedKey)
      || (platform !== "win32" && POSIX_LOWERCASE_ENV_KEYS.has(key));
    if (allowed && safeEnvironmentValue(value)) result[key] = value;
  }
  return result;
}

function defaultExecutableProbe(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve Kiro CLI without asking the OS to execute a bare PATH/CWD command.
 * Empty, relative, and network PATH entries are ignored.
 */
export function resolveKiroCliExecutable({
  platform = process.platform,
  environment = resolutionEnvironment(process.env, process.platform),
  isExecutable = defaultExecutableProbe,
} = {}) {
  if (typeof isExecutable !== "function") {
    throw connectorError("kiro_cli_resolver_invalid", "Kiro CLI executable probe is invalid");
  }
  const api = pathApi(platform);
  const env = resolutionEnvironment(environment, platform);
  const separator = platform === "win32" ? ";" : ":";
  const filename = platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
  const directories = [];
  const addDirectory = (candidate) => {
    if (typeof candidate !== "string") return;
    let value = candidate.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!isLocalAbsolutePath(value, platform)) return;
    const normalized = api.normalize(value);
    if (!directories.includes(normalized)) directories.push(normalized);
  };

  for (const entry of String(env.PATH ?? "").split(separator)) addDirectory(entry);
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  if (home) {
    addDirectory(api.join(home, ".local", "bin"));
    addDirectory(api.join(home, ".cargo", "bin"));
    addDirectory(api.join(home, ".kiro", "bin"));
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    addDirectory(api.join(env.LOCALAPPDATA, "Programs", "Kiro", "bin"));
  } else if (platform !== "win32") {
    addDirectory("/usr/local/bin");
    addDirectory("/opt/homebrew/bin");
    addDirectory("/usr/bin");
  }

  for (const directory of directories) {
    const candidate = api.join(directory, filename);
    if (isExecutable(candidate, platform)) return validateExecutable(candidate, platform);
  }
  return null;
}

function validateClock(value) {
  const source = value && typeof value === "object" ? value : {};
  const clock = {
    now: source.now ?? (() => Date.now()),
    setTimeout: source.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)),
    clearTimeout: source.clearTimeout ?? ((timer) => clearTimeout(timer)),
  };
  if (typeof clock.now !== "function" || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") {
    throw connectorError("kiro_cli_clock_invalid", "Kiro CLI clock is invalid");
  }
  return clock;
}

function boundedInteger(value, fallback, min, max, code) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw connectorError(code, "Kiro CLI numeric option is invalid");
  }
  return candidate;
}

function validateIdentityProvider(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw connectorError("kiro_cli_identity_provider_invalid", "Kiro Identity Center URL is invalid");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw connectorError("kiro_cli_identity_provider_invalid", "Kiro Identity Center URL is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !hostname.endsWith(".awsapps.com")
  ) {
    throw connectorError("kiro_cli_identity_provider_invalid", "Kiro Identity Center URL must be an HTTPS awsapps.com URL");
  }
  return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
}

function validateRegion(value) {
  const region = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!REGION_PATTERN.test(region) || region.length > 64) {
    throw connectorError("kiro_cli_region_invalid", "Kiro Identity Center region is invalid");
  }
  return region;
}

export function isValidKiroModelId(value) {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

function safeProgress(value) {
  return redactSensitiveText(String(value ?? "").replace(ANSI_PATTERN, ""))
    .replace(URL_SECRET_PATTERN, "$1[REDACTED]")
    .replace(SENSITIVE_HEADER_PATTERN, "$1$2[REDACTED]")
    .replace(SENSITIVE_KV_PATTERN, (_match, quote, key, separator) => `${quote}${key}${quote}${separator}[REDACTED]`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\barn:[a-z0-9-]+:[^\s,;]+/gi, "[REDACTED_ID]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]")
    .replace(/\b(?:email|user(?:name|_?id)?|profile_?id|account_?id)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)} [REDACTED_ID]`)
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function appendBoundedProgress(current, addition) {
  const combined = current + safeProgress(addition);
  if (combined.length <= MAX_PROGRESS_CHARS) return combined;
  const marker = "\n[Kyrei truncated Kiro CLI progress]\n";
  const half = Math.floor((MAX_PROGRESS_CHARS - marker.length) / 2);
  return `${combined.slice(0, half)}${marker}${combined.slice(-half)}`;
}

function appendProgressChunk(record, addition) {
  let text = record.pendingProgressLine + String(addition ?? "");
  record.pendingProgressLine = "";
  if (record.droppingProgressLine) {
    const newline = text.search(/\r?\n/);
    if (newline === -1) return;
    const width = text[newline] === "\r" && text[newline + 1] === "\n" ? 2 : 1;
    text = text.slice(newline + width);
    record.droppingProgressLine = false;
  }
  const rows = text.split(/\r?\n/);
  record.pendingProgressLine = rows.pop() ?? "";
  for (const row of rows) record.progress = appendBoundedProgress(record.progress, `${row}\n`);
  if (record.pendingProgressLine.length > MAX_PENDING_PROGRESS_LINE) {
    record.progress = appendBoundedProgress(record.progress, "[Kyrei omitted an overlong Kiro CLI progress line]\n");
    record.pendingProgressLine = "";
    record.droppingProgressLine = true;
  }
}

function publicProgress(record) {
  return record.droppingProgressLine
    ? record.progress
    : appendBoundedProgress(record.progress, record.pendingProgressLine);
}

function controlledVersion(output) {
  const match = String(output).match(/\bv?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,80})?)\b/);
  return match?.[1] ?? null;
}

function normalizedLoginOptions(options = {}) {
  const source = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const mode = source.mode ?? "browser";
  const method = source.method ?? "unified";
  if (!LOGIN_MODES.has(mode)) throw connectorError("kiro_cli_login_mode_invalid", "Kiro CLI login mode is invalid");
  if (!LOGIN_METHODS.has(method)) throw connectorError("kiro_cli_login_method_invalid", "Kiro CLI login method is invalid");

  let identityProvider;
  let region;
  if (method === "identity-center") {
    identityProvider = validateIdentityProvider(source.identityProvider);
    region = validateRegion(source.region);
  } else if (source.identityProvider !== undefined || source.region !== undefined) {
    throw connectorError("kiro_cli_login_options_invalid", "Identity Center options require the identity-center method");
  }

  const defaultTimeout = mode === "device" ? DEFAULT_DEVICE_LOGIN_TIMEOUT_MS : DEFAULT_BROWSER_LOGIN_TIMEOUT_MS;
  const timeoutMs = boundedInteger(
    source.timeoutMs,
    defaultTimeout,
    MIN_LOGIN_TIMEOUT_MS,
    MAX_LOGIN_TIMEOUT_MS,
    "kiro_cli_login_timeout_invalid",
  );
  return { mode, method, timeoutMs, ...(identityProvider ? { identityProvider, region } : {}) };
}

export function buildKiroLoginArgs(options = {}) {
  const normalized = normalizedLoginOptions(options);
  const args = ["login"];
  if (normalized.method === "free") args.push("--license", "free");
  if (normalized.method === "google" || normalized.method === "github") args.push("--social", normalized.method);
  if (normalized.method === "identity-center") {
    args.push(
      "--license", "pro",
      "--identity-provider", normalized.identityProvider,
      "--region", normalized.region,
    );
  }
  if (normalized.mode === "device") args.push("--use-device-flow");
  return { args, options: normalized };
}

function authenticationSummary(output, exitCode) {
  if (exitCode !== 0) return { authenticated: false, method: "none", accountType: "none" };
  let source;
  try {
    const parsed = JSON.parse(String(output).trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { authenticated: false, method: "none", accountType: "none" };
    }
    source = parsed;
  } catch {
    return { authenticated: false, method: "none", accountType: "none" };
  }

  const normalized = (value) => typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const account = normalized(source.accountType);
  const provider = normalized(source.provider);
  if (account === "social" && (provider === "github" || provider === "google")) {
    return { authenticated: true, method: provider, accountType: "free" };
  }
  if (["builderid", "awsbuilderid"].includes(account) && (!provider || ["builderid", "awsbuilderid"].includes(provider))) {
    return { authenticated: true, method: "builder-id", accountType: "free" };
  }
  if (["identitycenter", "iamidentitycenter", "enterprise", "pro"].includes(account)
      && (!provider || ["identitycenter", "iamidentitycenter", "awsidentitycenter"].includes(provider))) {
    return { authenticated: true, method: "identity-center", accountType: "enterprise" };
  }
  if (["apikey", "api"].includes(account) && (!provider || provider === "apikey")) {
    return { authenticated: true, method: "api-key", accountType: "api-key" };
  }
  return { authenticated: false, method: "none", accountType: "none" };
}

function parseModels(output) {
  let value;
  try {
    value = JSON.parse(String(output).trim());
  } catch {
    throw connectorError("kiro_cli_models_malformed", "Kiro CLI returned malformed model JSON");
  }
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value?.models)
      ? value.models
      : Array.isArray(value?.availableModels)
        ? value.availableModels
        : null;
  if (!rows) throw connectorError("kiro_cli_models_malformed", "Kiro CLI returned an unsupported model payload");
  if (rows.length > MAX_MODELS) throw connectorError("kiro_cli_models_limit", "Kiro CLI returned too many models");

  const seen = new Set();
  const models = [];
  for (const row of rows) {
    let id;
    if (typeof row === "string") {
      id = row;
    } else if (row && typeof row === "object" && !Array.isArray(row)) {
      const idFields = ["id", "modelId", "model_id"].filter((key) => Object.hasOwn(row, key));
      if (idFields.length === 0) throw connectorError("kiro_cli_model_id_missing", "Kiro CLI returned a model without an id");
      const values = idFields.map((key) => row[key]);
      if (new Set(values).size !== 1) throw connectorError("kiro_cli_model_id_invalid", "Kiro CLI returned conflicting model ids");
      [id] = values;
    } else {
      throw connectorError("kiro_cli_models_malformed", "Kiro CLI returned an invalid model row");
    }
    if (!isValidKiroModelId(id)) throw connectorError("kiro_cli_model_id_invalid", "Kiro CLI returned an invalid model id");
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

function snapshot(record) {
  return {
    id: record.id,
    status: record.status,
    mode: record.mode,
    method: record.method,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    progress: publicProgress(record),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function acquireAuthMutation(connector, kind, id = null) {
  if (globalAuthMutation) {
    throw connectorError("kiro_cli_auth_busy", "A Kiro CLI authentication change is already active");
  }
  const lock = { connector, kind, id, processStarted: false };
  globalAuthMutation = lock;
  return lock;
}

function releaseAuthMutation(lock) {
  if (globalAuthMutation === lock) globalAuthMutation = null;
}

export class KiroCliConnector {
  constructor({
    executable,
    resolveExecutable = resolveKiroCliExecutable,
    spawn = nodeSpawn,
    clock,
    idFactory = () => randomUUID(),
    environment = process.env,
    platform = process.platform,
    neutralCwd,
  } = {}) {
    if (typeof resolveExecutable !== "function") throw connectorError("kiro_cli_resolver_invalid", "Kiro CLI resolver is invalid");
    if (typeof spawn !== "function") throw connectorError("kiro_cli_spawn_invalid", "Kiro CLI spawn implementation is invalid");
    if (typeof idFactory !== "function") throw connectorError("kiro_cli_id_factory_invalid", "Kiro CLI id factory is invalid");
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw connectorError("kiro_cli_environment_invalid", "Kiro CLI environment is invalid");
    }
    this.platform = platform;
    this.resolveExecutable = resolveExecutable;
    this.resolutionEnvironment = resolutionEnvironment(environment, platform);
    this.childEnvironment = buildKiroCliEnvironment(environment, { platform });
    this.executable = executable === undefined ? null : validateExecutable(executable, platform);
    this.neutralCwd = neutralCwd === undefined ? null : this._validateNeutralCwd(neutralCwd);
    this.spawn = spawn;
    this.clock = validateClock(clock);
    this.idFactory = idFactory;
    this.logins = new Map();
    this.processes = new Set();
    this.quarantined = false;
    this.closed = false;
    this.closePromise = null;
  }

  capabilities() {
    return KIRO_CLI_ACCOUNT_CAPABILITIES;
  }

  _validateNeutralCwd(value) {
    if (!isLocalAbsolutePath(value, this.platform) || value.length > 1_024) {
      throw connectorError("kiro_cli_cwd_invalid", "Kiro CLI neutral working directory is invalid");
    }
    return pathApi(this.platform).normalize(value);
  }

  _assertOpen() {
    if (this.closed) throw connectorError("kiro_cli_connector_closed", "Kiro CLI connector is closed");
  }

  _assertRunnable() {
    this._assertOpen();
    if (this.quarantined) {
      throw connectorError("kiro_cli_connector_quarantined", "Kiro CLI connector is waiting for a previous process to exit");
    }
  }

  _resolvedExecutable() {
    if (this.executable) return this.executable;
    let candidate;
    try {
      candidate = this.resolveExecutable({ platform: this.platform, environment: { ...this.resolutionEnvironment } });
    } catch (error) {
      if (error instanceof KiroCliConnectorError) throw error;
      throw connectorError("kiro_cli_resolver_failed", "Kiro CLI executable resolution failed", error);
    }
    if (candidate && typeof candidate.then === "function") {
      throw connectorError("kiro_cli_resolver_invalid", "Kiro CLI resolver must be synchronous");
    }
    if (candidate == null || candidate === "") return null;
    this.executable = validateExecutable(candidate, this.platform);
    return this.executable;
  }

  _spawn(args, { stdin = "ignore" } = {}) {
    const executable = this._resolvedExecutable();
    if (!executable) throw connectorError("kiro_cli_not_found", "Kiro CLI is not installed");
    const cwd = this.neutralCwd ?? pathApi(this.platform).dirname(executable);
    try {
      return this.spawn(executable, args, {
        shell: false,
        windowsHide: true,
        cwd,
        stdio: [stdin, "pipe", "pipe"],
        env: { ...this.childEnvironment },
      });
    } catch (error) {
      const code = error?.code === "ENOENT" ? "kiro_cli_not_found" : "kiro_cli_start_failed";
      throw connectorError(code, code === "kiro_cli_not_found" ? "Kiro CLI is not installed" : "Kiro CLI could not start", error);
    }
  }

  _trackProcess(child, { onConfirmedExit } = {}) {
    let resolveExit;
    const record = {
      child,
      confirmed: false,
      forced: false,
      cancelForClose: null,
      onConfirmedExit,
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
      resolveExit,
    };
    this.processes.add(record);
    return record;
  }

  _refreshQuarantine() {
    this.quarantined = [...this.processes].some((record) => record.forced && !record.confirmed);
  }

  _confirmProcessExit(record) {
    if (record.confirmed) return;
    record.confirmed = true;
    this.processes.delete(record);
    try { record.onConfirmedExit?.(); } catch { /* cleanup callbacks are fail-closed */ }
    record.resolveExit?.();
    this._refreshQuarantine();
  }

  _forceStop(record) {
    if (record.confirmed) return;
    record.forced = true;
    this._refreshQuarantine();
    try { record.child.kill("SIGKILL"); } catch { /* process remains quarantined until close/error */ }
  }

  _run(args, {
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
    allowNonZero = false,
    authMutation = null,
  } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(args);
      } catch (error) {
        if (authMutation) releaseAuthMutation(authMutation);
        reject(error);
        return;
      }
      if (authMutation) authMutation.processStarted = true;
      const processRecord = this._trackProcess(child, {
        onConfirmedExit: authMutation ? () => releaseAuthMutation(authMutation) : undefined,
      });
      let settled = false;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let timer;

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) this.clock.clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const forceAndFinish = (error) => {
        this._forceStop(processRecord);
        finish(error);
      };
      const append = (channel, chunk) => {
        if (settled) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        outputBytes += Buffer.byteLength(text, "utf8");
        if (outputBytes > maxOutputBytes) {
          forceAndFinish(connectorError("kiro_cli_output_limit", "Kiro CLI output exceeded the configured limit"));
          return;
        }
        if (channel === "stdout") stdout += text;
        else stderr += text;
      };

      processRecord.cancelForClose = () => {
        finish(connectorError("kiro_cli_connector_closed", "Kiro CLI connector closed during command execution"));
        try { child.kill("SIGTERM"); } catch { /* close timeout owns escalation */ }
      };
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      child.once("error", (error) => {
        const code = error?.code === "ENOENT" ? "kiro_cli_not_found" : "kiro_cli_start_failed";
        finish(connectorError(code, code === "kiro_cli_not_found" ? "Kiro CLI is not installed" : "Kiro CLI could not start", error));
        this._confirmProcessExit(processRecord);
      });
      child.once("close", (code) => {
        const exitCode = Number.isInteger(code) ? code : null;
        if (exitCode === 0 || allowNonZero) finish(null, { stdout, stderr, exitCode });
        else finish(connectorError("kiro_cli_command_failed", "Kiro CLI command failed"));
        this._confirmProcessExit(processRecord);
      });
      timer = this.clock.setTimeout(() => {
        forceAndFinish(connectorError("kiro_cli_timeout", "Kiro CLI command timed out"));
      }, timeoutMs);
    });
  }

  async detect() {
    this._assertRunnable();
    try {
      const result = await this._run(["--version"], { timeoutMs: 10_000, maxOutputBytes: 32_000 });
      return { installed: true, version: controlledVersion(`${result.stdout}\n${result.stderr}`) };
    } catch (error) {
      if (error?.code === "kiro_cli_not_found") return { installed: false, version: null };
      throw error;
    }
  }

  async whoami() {
    this._assertRunnable();
    const result = await this._run(["whoami", "--format", "json"], {
      timeoutMs: 15_000,
      maxOutputBytes: 64_000,
      allowNonZero: true,
    });
    return authenticationSummary(result.stdout, result.exitCode);
  }

  async discoverModels() {
    this._assertRunnable();
    const result = await this._run(["chat", "--list-models", "--format", "json"], {
      timeoutMs: 30_000,
      maxOutputBytes: 256_000,
    });
    return parseModels(result.stdout);
  }

  _pruneLoginRecords() {
    if (this.logins.size < MAX_LOGIN_RECORDS) return;
    for (const [id, record] of this.logins) {
      if (this.logins.size < MAX_LOGIN_RECORDS) break;
      if (TERMINAL_LOGIN_STATUSES.has(record.status) && record.process?.confirmed) this.logins.delete(id);
    }
  }

  _finishLogin(record, status, { exitCode, error } = {}) {
    if (!TERMINAL_LOGIN_STATUSES.has(record.status)) {
      const now = this.clock.now();
      record.status = status;
      record.updatedAt = now;
      record.finishedAt = now;
      if (Number.isInteger(exitCode)) record.exitCode = exitCode;
      if (error) record.error = error;
    }
    if (record.timer) {
      this.clock.clearTimeout(record.timer);
      record.timer = null;
    }
  }

  startLogin(options = {}) {
    this._assertRunnable();
    const built = buildKiroLoginArgs(options);
    this._pruneLoginRecords();
    const id = String(this.idFactory());
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.logins.has(id)) {
      throw connectorError("kiro_cli_login_id_invalid", "Kiro CLI login id is invalid or already used");
    }
    const authMutation = acquireAuthMutation(this, "login", id);
    let child;
    try {
      child = this._spawn(built.args, { stdin: built.options.mode === "browser" ? "pipe" : "ignore" });
    } catch (error) {
      releaseAuthMutation(authMutation);
      throw error;
    }

    const now = this.clock.now();
    const record = {
      id,
      mode: built.options.mode,
      method: built.options.method,
      status: "running",
      startedAt: now,
      updatedAt: now,
      progress: "",
      pendingProgressLine: "",
      droppingProgressLine: false,
      outputBytes: 0,
      child,
      process: null,
      timer: null,
    };
    authMutation.processStarted = true;
    record.process = this._trackProcess(child, { onConfirmedExit: () => releaseAuthMutation(authMutation) });
    record.process.cancelForClose = () => {
      if (!TERMINAL_LOGIN_STATUSES.has(record.status)) this._finishLogin(record, "cancelled");
      try { child.kill("SIGTERM"); } catch { /* close timeout owns escalation */ }
    };
    this.logins.set(id, record);
    if (built.options.mode === "browser" && child.stdin) {
      child.stdin.on("error", () => { /* close/error handlers own process state */ });
      child.stdin.end("\n");
    }

    const append = (chunk) => {
      if (record.status !== "running") return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      record.outputBytes += Buffer.byteLength(text, "utf8");
      record.updatedAt = this.clock.now();
      if (record.outputBytes > MAX_LOGIN_OUTPUT_BYTES) {
        this._finishLogin(record, "failed", { error: "kiro_cli_output_limit" });
        this._forceStop(record.process);
        return;
      }
      appendProgressChunk(record, text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      const code = error?.code === "ENOENT" ? "kiro_cli_not_found" : "kiro_cli_start_failed";
      this._finishLogin(record, "failed", { error: code });
      this._confirmProcessExit(record.process);
    });
    child.once("close", (code) => {
      if (record.status === "running") {
        this._finishLogin(record, code === 0 ? "succeeded" : "failed", {
          exitCode: Number.isInteger(code) ? code : undefined,
          ...(code === 0 ? {} : { error: "kiro_cli_login_failed" }),
        });
      }
      this._confirmProcessExit(record.process);
    });
    record.timer = this.clock.setTimeout(() => {
      this._finishLogin(record, "timed-out", { error: "kiro_cli_login_timeout" });
      this._forceStop(record.process);
    }, built.options.timeoutMs);
    return snapshot(record);
  }

  getLoginStatus(id) {
    this._assertOpen();
    const record = this.logins.get(id);
    if (!record) throw connectorError("kiro_cli_login_not_found", "Kiro CLI login was not found");
    return snapshot(record);
  }

  activeLogin() {
    this._assertOpen();
    if (globalAuthMutation?.connector !== this || globalAuthMutation.kind !== "login") return null;
    const record = this.logins.get(globalAuthMutation.id);
    return record ? snapshot(record) : null;
  }

  cancelLogin(id) {
    this._assertOpen();
    const record = this.logins.get(id);
    if (!record) throw connectorError("kiro_cli_login_not_found", "Kiro CLI login was not found");
    if (!TERMINAL_LOGIN_STATUSES.has(record.status)) {
      this._finishLogin(record, "cancelled");
      try { record.child.kill("SIGTERM"); } catch { /* auth remains locked until confirmed exit */ }
    }
    return snapshot(record);
  }

  async logout() {
    this._assertRunnable();
    const authMutation = acquireAuthMutation(this, "logout");
    await this._run(["logout"], {
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      authMutation,
    });
    return { loggedOut: true };
  }

  close({ timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS } = {}) {
    if (this.closePromise) return this.closePromise;
    const boundedTimeout = boundedInteger(
      timeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
      MIN_CLOSE_TIMEOUT_MS,
      MAX_CLOSE_TIMEOUT_MS,
      "kiro_cli_close_timeout_invalid",
    );
    this.closed = true;
    this.closePromise = (async () => {
      const active = [...this.processes].filter((record) => !record.confirmed);
      for (const record of active) record.cancelForClose?.();
      if (!active.length) return;

      let timeoutTimer;
      const timeout = new Promise((resolve) => {
        timeoutTimer = this.clock.setTimeout(() => resolve("timeout"), boundedTimeout);
      });
      const released = Promise.all(active.map((record) => record.exitPromise)).then(() => "released");
      const outcome = await Promise.race([released, timeout]);
      this.clock.clearTimeout(timeoutTimer);
      if (outcome !== "timeout") return;

      // A successful kill request is not proof of process exit. Keep both the
      // connector and any auth mutation quarantined until close/error arrives.
      for (const record of active) if (!record.confirmed) this._forceStop(record);
    })();
    return this.closePromise;
  }

  dispose(options) {
    return this.close(options);
  }
}
