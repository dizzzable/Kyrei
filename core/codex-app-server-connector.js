/**
 * Official ChatGPT / Codex integration through the local `codex app-server`.
 *
 * Kyrei deliberately never imports browser cookies, access tokens, or refresh
 * tokens.  The official Codex CLI owns the ChatGPT OAuth lifecycle and exposes
 * only its documented JSON-RPC surface over a child stdio transport.
 */

import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "./secret-redaction.js";

const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_RPC_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 8_000;
const MAX_LOGIN_RECORDS = 16;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const SAFE_PLAN = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,80})?$/;
const TERMINAL_LOGIN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed-out"]);

const CHILD_ENV_KEYS = new Set([
  "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
const POSIX_LOWERCASE_ENV_KEYS = new Set(["https_proxy", "http_proxy", "all_proxy", "no_proxy"]);
const RESOLUTION_ENV_KEYS = new Set(["PATH", "PATHEXT", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]);

export const CODEX_CHATGPT_PROVIDER_ID = "openai-codex-chatgpt";
export const CODEX_CHATGPT_DEFAULT_MODEL = "chatgpt-default";
export const CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/codex";

export class CodexAppServerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function connectorError(code, message, cause) {
  return new CodexAppServerError(code, message, cause ? { cause } : undefined);
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function safeEnvironmentValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0");
}

function isLocalAbsolutePath(value, platform) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const api = pathApi(platform);
  if (!api.isAbsolute(value)) return false;
  return platform !== "win32" || (!value.startsWith("\\\\") && !value.startsWith("//"));
}

function validateExecutable(value, platform = process.platform) {
  if (!isLocalAbsolutePath(value, platform) || value.length > 1_024) {
    throw connectorError("codex_app_server_executable_invalid", "Codex executable must be an absolute local path");
  }
  const api = pathApi(platform);
  const normalized = api.normalize(value);
  const base = api.basename(normalized).toLowerCase();
  const allowed = platform === "win32"
    ? ["codex.exe", "codex.cmd"].includes(base)
    : base === "codex";
  if (!allowed) throw connectorError("codex_app_server_executable_invalid", "Codex executable name is invalid");
  return normalized;
}

function resolutionEnvironment(source, platform) {
  const result = {};
  for (const [key, value] of Object.entries(source && typeof source === "object" ? source : {})) {
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    if (RESOLUTION_ENV_KEYS.has(normalizedKey) && safeEnvironmentValue(value)) result[normalizedKey] = value;
  }
  return result;
}

/** Build the small environment inherited by the official Codex CLI. */
export function buildCodexAppServerEnvironment(source = process.env, { platform = process.platform, codexHome } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(source && typeof source === "object" ? source : {})) {
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    const allowed = CHILD_ENV_KEYS.has(normalizedKey)
      || (platform !== "win32" && POSIX_LOWERCASE_ENV_KEYS.has(key));
    if (allowed && safeEnvironmentValue(value)) result[key] = value;
  }
  // CODEX_HOME is deliberately never inherited from the parent process.  An
  // isolated account profile is an explicit Kyrei-owned boundary; inheriting a
  // developer's shell setting here could silently bind one account to another
  // profile.  The value is validated again at the connector constructor.
  if (codexHome !== undefined) {
    if (!isLocalAbsolutePath(codexHome, platform) || codexHome.length > 4_096) {
      throw connectorError("codex_app_server_home_invalid", "Codex profile directory must be an absolute local path");
    }
    result.CODEX_HOME = pathApi(platform).normalize(codexHome);
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

/** Resolve a local Codex executable without executing a bare PATH command. */
export function resolveCodexAppServerExecutable({
  platform = process.platform,
  environment = resolutionEnvironment(process.env, process.platform),
  isExecutable = defaultExecutableProbe,
} = {}) {
  if (typeof isExecutable !== "function") {
    throw connectorError("codex_app_server_resolver_invalid", "Codex executable probe is invalid");
  }
  const api = pathApi(platform);
  const env = resolutionEnvironment(environment, platform);
  const separator = platform === "win32" ? ";" : ":";
  const files = platform === "win32" ? ["codex.cmd", "codex.exe"] : ["codex"];
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
  }
  if (platform !== "win32") {
    addDirectory("/usr/local/bin");
    addDirectory("/opt/homebrew/bin");
    addDirectory("/usr/bin");
  }
  for (const directory of directories) {
    for (const filename of files) {
      const candidate = api.join(directory, filename);
      if (isExecutable(candidate, platform)) return validateExecutable(candidate, platform);
    }
  }
  return null;
}

function isRegularFile(value) {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function cmdLaunch(executable, platform, environment) {
  const api = pathApi(platform);
  const directory = api.dirname(executable);
  const entrypoint = api.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
  const localNode = api.join(directory, platform === "win32" ? "node.exe" : "node");
  if (isRegularFile(localNode) && isRegularFile(entrypoint)) {
    return { command: localNode, prefix: [entrypoint] };
  }
  // A global npm shim normally has the package beside it.  Resolve an absolute
  // Node binary only; never execute a bare `node` from a command string.
  const env = resolutionEnvironment(environment, platform);
  const separator = platform === "win32" ? ";" : ":";
  const nodeName = platform === "win32" ? "node.exe" : "node";
  for (const directoryEntry of String(env.PATH ?? "").split(separator)) {
    if (!isLocalAbsolutePath(directoryEntry.trim(), platform)) continue;
    const node = api.join(api.normalize(directoryEntry.trim()), nodeName);
    if (isRegularFile(node) && isRegularFile(entrypoint)) return { command: node, prefix: [entrypoint] };
  }
  throw connectorError(
    "codex_app_server_npm_runtime_unavailable",
    "The Codex npm launcher does not have an executable Node runtime",
  );
}

function launchSpec(executable, platform, environment) {
  const normalized = validateExecutable(executable, platform);
  if (platform === "win32" && normalized.toLowerCase().endsWith(".cmd")) {
    return cmdLaunch(normalized, platform, environment);
  }
  return { command: normalized, prefix: [] };
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length <= MAX_STDERR_CHARS ? next : next.slice(-MAX_STDERR_CHARS);
}

function safeErrorText(value) {
  return redactSensitiveText(String(value ?? ""))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/([?#&](?:access_token|refresh_token|id_token|token|state|code)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function statusFromAccount(result) {
  const account = asRecord(asRecord(result).account);
  const type = account.type === "chatgpt" ? "chatgpt" : "none";
  const plan = typeof account.planType === "string" && SAFE_PLAN.test(account.planType)
    ? account.planType
    : null;
  return { authenticated: type === "chatgpt", authMode: type, planType: plan };
}

function versionFromOutput(output) {
  const match = String(output).match(/\bv?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,80})?)\b/);
  return match?.[1] && SAFE_VERSION.test(match[1]) ? match[1] : null;
}

class JsonRpcProcess {
  constructor({ child, clock, onNotification }) {
    this.child = child;
    this.clock = clock;
    this.onNotification = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.stdout = "";
    this.stderr = "";
    this.closed = false;
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => this.#onStdout(chunk));
    child.stderr?.on?.("data", (chunk) => { this.stderr = appendBounded(this.stderr, String(chunk)); });
    child.on?.("error", (error) => this.#failAll(error));
    child.on?.("exit", (code, signal) => {
      if (!this.closed) this.#failAll(connectorError("codex_app_server_exited", `Codex app-server exited (${code ?? signal ?? "unknown"})`));
    });
  }

  #onStdout(chunk) {
    this.stdout += String(chunk);
    if (Buffer.byteLength(this.stdout) > MAX_RPC_LINE_BYTES) {
      this.#failAll(connectorError("codex_app_server_protocol_invalid", "Codex app-server sent an oversized response"));
      return;
    }
    const lines = this.stdout.split(/\r?\n/);
    this.stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#failAll(connectorError("codex_app_server_protocol_invalid", "Codex app-server sent invalid JSON-RPC"));
        return;
      }
      if (Object.hasOwn(message, "id") && (typeof message.id === "number" || typeof message.id === "string")) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        this.clock.clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(connectorError("codex_app_server_rpc_error", safeErrorText(message.error?.message || "Codex RPC failed")));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === "string") {
        try { this.onNotification?.(message.method, asRecord(message.params)); } catch { /* host listener is isolated */ }
      }
    }
  }

  #failAll(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer);
      pending.reject(reason instanceof Error ? reason : connectorError("codex_app_server_failed", safeErrorText(reason)));
    }
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed || !this.child.stdin?.writable) {
      return Promise.reject(connectorError("codex_app_server_unavailable", "Codex app-server is not available"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(connectorError("codex_app_server_timeout", `Codex app-server timed out during ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        this.clock.clearTimeout(timer);
        reject(connectorError("codex_app_server_write_failed", "Cannot write to Codex app-server", error));
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed || !this.child.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); } catch { /* close path */ }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer);
      pending.reject(connectorError("codex_app_server_closed", "Codex app-server connection closed"));
    }
    this.pending.clear();
    try { this.child.stdin?.end?.(); } catch { /* best effort */ }
    const child = this.child;
    this.clock.setTimeout(() => {
      if (!child.killed) {
        try { child.kill(); } catch { /* best effort */ }
      }
    }, CLOSE_GRACE_MS);
  }
}

function defaultClock() {
  return {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function normalizeClock(clock) {
  const resolved = clock ?? defaultClock();
  if (typeof resolved.setTimeout !== "function" || typeof resolved.clearTimeout !== "function") {
    throw connectorError("codex_app_server_clock_invalid", "Codex app-server clock is invalid");
  }
  return resolved;
}

/**
 * Process adapter for the official Codex App Server protocol.
 * A process is intentionally short-lived per status/login/turn request: Codex
 * persists its own account state and durable threads, so Kyrei never becomes a
 * second OAuth credential store.
 */
/**
 * Translate Kyrei's provider-neutral model controls to the official Codex
 * app-server names. Unsupported or malformed input is deliberately omitted:
 * passing arbitrary settings into a native runtime would make the UI claim a
 * value that Codex never accepted.
 */
export function normalizeCodexTurnModelParams(modelParams) {
  if (!modelParams || typeof modelParams !== "object" || Array.isArray(modelParams)) return {};
  const result = {};
  if (typeof modelParams.effort === "string" && /^(minimal|low|medium|high|xhigh)$/.test(modelParams.effort)) {
    result.reasoningEffort = modelParams.effort;
  }
  if (modelParams.fast === true) {
    result.serviceTier = "priority";
  } else if (modelParams.fast === false) {
    result.serviceTier = "default";
  } else if (typeof modelParams.fast === "string" && /^(default|fast|flex|priority)$/.test(modelParams.fast)) {
    result.serviceTier = modelParams.fast;
  }
  return result;
}

/**
 * The app-server schema accepts model/service-tier overrides on both a newly
 * started thread and a resumed one.  Keeping the shape in one place prevents a
 * changed Kyrei preset from silently applying only after the user creates a
 * completely new chat.
 */
function codexThreadTuningParams(nativeModelParams, model) {
  return {
    ...(typeof model === "string" && model !== CODEX_CHATGPT_DEFAULT_MODEL && SAFE_MODEL_ID.test(model)
      ? { model }
      : {}),
    ...(nativeModelParams.reasoningEffort
      ? { config: { model_reasoning_effort: nativeModelParams.reasoningEffort } }
      : {}),
    ...(nativeModelParams.serviceTier ? { serviceTier: nativeModelParams.serviceTier } : {}),
  };
}

export class CodexAppServerConnector {
  constructor({
    executable,
    resolveExecutable = resolveCodexAppServerExecutable,
    spawn = nodeSpawn,
    environment = process.env,
    platform = process.platform,
    clock,
    version = "development",
    codexHome,
  } = {}) {
    if (typeof resolveExecutable !== "function" || typeof spawn !== "function") {
      throw connectorError("codex_app_server_constructor_invalid", "Codex app-server connector is invalid");
    }
    this.platform = platform;
    this.environment = environment;
    this.resolveExecutable = resolveExecutable;
    this.spawn = spawn;
    this.clock = normalizeClock(clock);
    this.version = typeof version === "string" && version.length <= 80 ? version : "development";
    this.executable = executable === undefined ? undefined : validateExecutable(executable, platform);
    this.codexHome = codexHome === undefined
      ? undefined
      : isLocalAbsolutePath(codexHome, platform) && codexHome.length <= 4_096
        ? pathApi(platform).normalize(codexHome)
        : (() => { throw connectorError("codex_app_server_home_invalid", "Codex profile directory must be an absolute local path"); })();
    this.logins = new Map();
  }

  /**
   * Make an isolated official-runtime profile.  It intentionally shares only
   * executable discovery and operational environment with the parent
   * connector; ChatGPT authorization remains inside the supplied CODEX_HOME.
   */
  createProfile({ codexHome } = {}) {
    return new CodexAppServerConnector({
      executable: this.executable,
      resolveExecutable: this.resolveExecutable,
      spawn: this.spawn,
      environment: this.environment,
      platform: this.platform,
      clock: this.clock,
      version: this.version,
      codexHome,
    });
  }

  #executable() {
    const executable = this.executable ?? this.resolveExecutable({
      platform: this.platform,
      environment: resolutionEnvironment(this.environment, this.platform),
    });
    return executable ? validateExecutable(executable, this.platform) : null;
  }

  #spawn(args, onNotification) {
    const executable = this.#executable();
    if (!executable) throw connectorError("codex_app_server_not_installed", "Official Codex CLI is not installed");
    const launch = launchSpec(executable, this.platform, this.environment);
    const child = this.spawn(launch.command, [...launch.prefix, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: buildCodexAppServerEnvironment(this.environment, { platform: this.platform, codexHome: this.codexHome }),
    });
    return new JsonRpcProcess({ child, clock: this.clock, onNotification });
  }

  async #connect(onNotification) {
    const client = this.#spawn(["app-server"], onNotification);
    try {
      await client.request("initialize", {
        clientInfo: { name: "kyrei", title: "Kyrei", version: this.version },
      }, CONNECT_TIMEOUT_MS);
      client.notify("initialized", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #runVersion() {
    const executable = this.#executable();
    if (!executable) return null;
    const launch = launchSpec(executable, this.platform, this.environment);
    const child = this.spawn(launch.command, [...launch.prefix, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: buildCodexAppServerEnvironment(this.environment, { platform: this.platform, codexHome: this.codexHome }),
    });
    return new Promise((resolve) => {
      let output = "";
      const done = () => resolve(versionFromOutput(output));
      const timer = this.clock.setTimeout(() => {
        try { child.kill(); } catch { /* timeout */ }
        done();
      }, CONNECT_TIMEOUT_MS);
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on?.("data", (chunk) => { output = appendBounded(output, String(chunk)); });
      child.on?.("error", () => { this.clock.clearTimeout(timer); done(); });
      child.on?.("exit", () => { this.clock.clearTimeout(timer); done(); });
    });
  }

  async detect() {
    const executable = this.#executable();
    if (!executable) return { installed: false, version: null };
    return { installed: true, version: await this.#runVersion() };
  }

  async account({ refreshToken = false } = {}) {
    const client = await this.#connect();
    try {
      return statusFromAccount(await client.request("account/read", { refreshToken: refreshToken === true }));
    } finally {
      await client.close();
    }
  }

  activeLogin() {
    for (const record of this.logins.values()) {
      if (!TERMINAL_LOGIN_STATUSES.has(record.status)) return publicLoginRecord(record);
    }
    return null;
  }

  async status() {
    const detected = await this.detect();
    if (!detected.installed) {
      return { ...detected, authenticated: false, authMode: "none", planType: null, activeLogin: this.activeLogin() };
    }
    try {
      return { ...detected, ...await this.account(), activeLogin: this.activeLogin() };
    } catch (error) {
      return {
        ...detected,
        authenticated: false,
        authMode: "none",
        planType: null,
        activeLogin: this.activeLogin(),
        error: error instanceof CodexAppServerError ? error.code : "codex_app_server_unavailable",
      };
    }
  }

  async startLogin({ mode = "browser" } = {}) {
    if (mode !== "browser" && mode !== "device") {
      throw connectorError("codex_app_server_login_mode_invalid", "Codex sign-in mode is invalid");
    }
    if (this.activeLogin()) throw connectorError("codex_app_server_login_active", "A Codex sign-in is already running");
    let record;
    const client = await this.#connect((method, params) => {
      if (!record) return;
      if (method === "account/login/completed" && params.loginId === record.id) {
        record.status = params.success === true ? "succeeded" : "failed";
        record.updatedAt = Date.now();
        record.finishedAt = record.updatedAt;
        record.error = params.success === true ? undefined : "codex_app_server_login_failed";
        void client.close();
      }
      if (method === "account/updated" && params.authMode === "chatgpt") {
        record.planType = typeof params.planType === "string" && SAFE_PLAN.test(params.planType) ? params.planType : null;
      }
    });
    try {
      const result = asRecord(await client.request("account/login/start", {
        type: mode === "browser" ? "chatgpt" : "chatgptDeviceCode",
        ...(mode === "browser" ? { useHostedLoginSuccessPage: true, appBrand: "chatgpt" } : {}),
      }, REQUEST_TIMEOUT_MS));
      const id = typeof result.loginId === "string" && SAFE_ID.test(result.loginId) ? result.loginId : "";
      if (!id) throw connectorError("codex_app_server_login_invalid", "Codex returned an invalid sign-in request");
      const now = Date.now();
      record = {
        id,
        mode,
        status: "running",
        startedAt: now,
        updatedAt: now,
        client,
        ...(typeof result.authUrl === "string" && result.authUrl.length <= 8_192 ? { authUrl: result.authUrl } : {}),
        ...(typeof result.verificationUrl === "string" && result.verificationUrl.length <= 1_024 ? { verificationUrl: result.verificationUrl } : {}),
        ...(typeof result.userCode === "string" && /^[A-Z0-9-]{4,64}$/i.test(result.userCode) ? { userCode: result.userCode } : {}),
      };
      this.logins.set(id, record);
      this.#trimLogins();
      const timeout = this.clock.setTimeout(() => {
        if (!record || record.status !== "running") return;
        record.status = "timed-out";
        record.updatedAt = Date.now();
        record.finishedAt = record.updatedAt;
        record.error = "codex_app_server_login_timed_out";
        void client.request("account/login/cancel", { loginId: record.id }).catch(() => undefined).finally(() => client.close());
      }, LOGIN_TIMEOUT_MS);
      record.timeout = timeout;
      return publicLoginRecord(record);
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  loginStatus(id) {
    const record = this.logins.get(id);
    if (!record) throw connectorError("codex_app_server_login_not_found", "Codex sign-in was not found");
    return publicLoginRecord(record);
  }

  async cancelLogin(id) {
    const record = this.logins.get(id);
    if (!record) throw connectorError("codex_app_server_login_not_found", "Codex sign-in was not found");
    if (record.status === "running") {
      try { await record.client.request("account/login/cancel", { loginId: id }); } catch { /* terminal state below */ }
      record.status = "cancelled";
      record.updatedAt = Date.now();
      record.finishedAt = record.updatedAt;
      record.error = undefined;
      this.clock.clearTimeout(record.timeout);
      await record.client.close();
    }
    return publicLoginRecord(record);
  }

  async logout() {
    if (this.activeLogin()) throw connectorError("codex_app_server_login_active", "Finish the active Codex sign-in first");
    const client = await this.#connect();
    try {
      await client.request("account/logout", {});
      return { loggedOut: true };
    } finally {
      await client.close();
    }
  }

  async runTurn({ threadId, prompt, images = [], workspace, model, modelParams, accountId, onThread, onEvent, signal } = {}) {
    if (typeof prompt !== "string") throw connectorError("codex_app_server_prompt_invalid", "Codex prompt is invalid");
    if (typeof workspace !== "string" || !workspace.trim()) {
      throw connectorError("codex_app_server_workspace_required", "Codex requires a workspace");
    }
    const toolItems = new Map();
    const parts = [];
    let text = "";
    let completed = null;
    let resolveTurn;
    let rejectTurn;
    const turnDone = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    const emit = (event) => { try { onEvent?.(event); } catch { /* gateway owns stream failure */ } };
    const appendPart = (part) => { parts.push(part); return part; };
    const client = await this.#connect((method, params) => {
      if (method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) {
          text += delta;
          emit({ type: "message.delta", payload: { text: delta } });
        }
        return;
      }
      if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) emit({ type: "reasoning.delta", payload: { text: delta } });
        return;
      }
      if (method === "item/started") {
        const item = asRecord(params.item);
        const itemId = typeof item.id === "string" ? item.id : "";
        const type = typeof item.type === "string" ? item.type : "";
        if (!itemId || !["commandExecution", "fileChange", "mcpToolCall", "webSearch", "collabToolCall"].includes(type)) return;
        const name = type === "commandExecution" ? "run_command"
          : type === "fileChange" ? "write_file"
            : type === "mcpToolCall" ? `mcp:${String(item.server || "server")}/${String(item.tool || "tool")}`
              : type === "webSearch" ? "web_search"
                : `codex:${type}`;
        const args = type === "commandExecution"
          ? { command: item.command, cwd: item.cwd }
          : type === "fileChange" ? { changes: item.changes }
            : type === "mcpToolCall" ? item.arguments
              : type === "webSearch" ? { query: item.query }
                : {};
        const tool = { toolCallId: itemId, name, args, running: true };
        toolItems.set(itemId, tool);
        appendPart({ type: "tool", ...tool });
        emit({ type: "tool.start", payload: { tool_call_id: itemId, name, args } });
        return;
      }
      if (method === "item/commandExecution/outputDelta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (itemId && delta) emit({ type: "tool.progress", payload: { tool_call_id: itemId, text: delta } });
        return;
      }
      if (method === "item/completed") {
        const item = asRecord(params.item);
        const itemId = typeof item.id === "string" ? item.id : "";
        const type = typeof item.type === "string" ? item.type : "";
        if (type === "agentMessage" && !text && typeof item.text === "string") text = item.text;
        if (type === "reasoning" && typeof item.summary === "string" && item.summary) {
          emit({ type: "reasoning.delta", payload: { text: item.summary } });
        }
        const tool = toolItems.get(itemId);
        if (!tool) return;
        const failed = item.status === "failed" || item.status === "declined";
        const result = type === "commandExecution" ? String(item.aggregatedOutput ?? "")
          : type === "mcpToolCall" ? String(item.result ?? "")
            : type === "webSearch" ? JSON.stringify(item.results ?? "")
              : type === "fileChange" ? JSON.stringify(item.changes ?? "") : "";
        const error = failed ? safeErrorText(item.error ?? item.status ?? "tool_failed") : undefined;
        const updated = { ...tool, running: false, ...(result ? { result } : {}), ...(error ? { error } : {}) };
        const index = parts.findIndex((part) => part.type === "tool" && part.toolCallId === itemId);
        if (index >= 0) parts[index] = { type: "tool", ...updated };
        emit({ type: "tool.complete", payload: {
          tool_call_id: itemId,
          name: tool.name,
          ...(result ? { result } : {}),
          ...(error ? { error } : {}),
          duration_s: Number.isFinite(item.durationMs) ? item.durationMs / 1_000 : 0,
        } });
        return;
      }
      if (method === "turn/completed") {
        completed = asRecord(params.turn);
        if (completed.status === "completed") resolveTurn();
        else if (completed.status === "interrupted") rejectTurn(Object.assign(new Error("interrupted"), { name: "AbortError" }));
        else rejectTurn(connectorError("codex_app_server_turn_failed", safeErrorText(asRecord(completed.error).message || "Codex turn failed")));
      }
    });
    const nativeModelParams = normalizeCodexTurnModelParams(modelParams);
    let activeThreadId = typeof threadId === "string" && SAFE_ID.test(threadId) ? threadId : "";
    const abort = () => {
      if (activeThreadId) void client.request("turn/interrupt", { threadId: activeThreadId }).catch(() => undefined);
    };
    try {
      if (signal?.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" });
      signal?.addEventListener?.("abort", abort, { once: true });
      if (activeThreadId) {
        try {
          await client.request("thread/resume", {
            threadId: activeThreadId,
            cwd: workspace,
            ...codexThreadTuningParams(nativeModelParams, model),
          });
        } catch {
          activeThreadId = "";
        }
      }
      if (!activeThreadId) {
        const started = asRecord(await client.request("thread/start", {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          personality: "friendly",
          ...codexThreadTuningParams(nativeModelParams, model),
        }));
        activeThreadId = typeof asRecord(started.thread).id === "string" ? asRecord(started.thread).id : "";
        if (!SAFE_ID.test(activeThreadId)) throw connectorError("codex_app_server_thread_invalid", "Codex returned an invalid thread id");
        await onThread?.(activeThreadId);
      }
      const input = [{ type: "text", text: prompt }];
      for (const image of Array.isArray(images) ? images : []) {
        if (typeof image?.path === "string" && image.path.length <= 4_096) input.push({ type: "localImage", path: image.path });
      }
      await client.request("turn/start", {
        threadId: activeThreadId,
        clientUserMessageId: `kyrei-${randomUUID()}`,
        input,
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      await turnDone;
      const usage = asRecord(completed?.usage);
      const inputTokens = Number(usage.inputTokens ?? usage.promptTokens) || 0;
      const outputTokens = Number(usage.outputTokens ?? usage.completionTokens) || 0;
      const totalTokens = Number(usage.totalTokens) || inputTokens + outputTokens;
      if (text) appendPart({ type: "text", text });
      return {
        text,
        parts,
        status: "complete",
        route: {
          providerId: CODEX_CHATGPT_PROVIDER_ID,
          modelId: model || CODEX_CHATGPT_DEFAULT_MODEL,
          ...(typeof accountId === "string" && SAFE_ID.test(accountId) ? { accountId } : {}),
        },
        ...(inputTokens || outputTokens || totalTokens ? { usage: { inputTokens, outputTokens, totalTokens } } : {}),
      };
    } finally {
      signal?.removeEventListener?.("abort", abort);
      await client.close();
    }
  }

  async close() {
    for (const record of this.logins.values()) {
      this.clock.clearTimeout(record.timeout);
      await record.client?.close?.();
    }
    this.logins.clear();
  }

  #trimLogins() {
    while (this.logins.size > MAX_LOGIN_RECORDS) {
      const id = this.logins.keys().next().value;
      if (!id) return;
      const record = this.logins.get(id);
      this.clock.clearTimeout(record?.timeout);
      this.logins.delete(id);
    }
  }
}

function publicLoginRecord(record) {
  return {
    id: record.id,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.authUrl ? { authUrl: record.authUrl } : {}),
    ...(record.verificationUrl ? { verificationUrl: record.verificationUrl } : {}),
    ...(record.userCode ? { userCode: record.userCode } : {}),
    ...(record.planType ? { planType: record.planType } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}
