/**
 * Bounded headless worker for organization-scoped Kiro CLI API keys.
 *
 * Only the separately installed official `kiro-cli` binary is executed. Each
 * account receives an independent KIRO_HOME and KIRO_API_KEY is supplied only
 * in the child environment. This module never reads Kiro credential files and
 * never calls private Kiro/Amazon Q endpoints.
 */

import { spawn as nodeSpawn } from "node:child_process";
import {
  chmod as nodeChmod,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  buildKiroCliEnvironment,
  isValidKiroModelId,
  resolveKiroCliExecutable,
} from "./kiro-cli-connector.js";
import {
  normalizeKiroOrganizationAccountSecret,
  validateKiroOrganizationAccountId,
} from "./kiro-organization-config.js";

export const KIRO_ORGANIZATION_MINIMUM_CLI_VERSION = "1.28.0";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256_000;
const MAX_MODELS = 512;
const MAX_MODEL_NAME_LENGTH = 120;
const PROFILE_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export class KiroOrganizationWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "KiroOrganizationWorkerError";
    this.code = code;
  }
}

function workerError(code, message) {
  return new KiroOrganizationWorkerError(code, message);
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function isLocalAbsolutePath(value, platform) {
  if (typeof value !== "string" || !value || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const api = pathApi(platform);
  if (!api.isAbsolute(value)) return false;
  return platform === "win32"
    ? !value.startsWith("\\\\") && !value.startsWith("//")
    : !value.startsWith("//");
}

function validateExecutable(value, platform) {
  if (!isLocalAbsolutePath(value, platform)) {
    throw workerError("kiro_organization_cli_executable_invalid", "Kiro CLI executable must be an absolute local path");
  }
  const api = pathApi(platform);
  const normalized = api.normalize(value);
  const expected = platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
  if (api.basename(normalized).toLowerCase() !== expected) {
    throw workerError("kiro_organization_cli_executable_invalid", "Kiro CLI executable name is invalid");
  }
  return normalized;
}

function validateClock(value) {
  const source = value && typeof value === "object" ? value : {};
  const clock = {
    now: source.now ?? (() => Date.now()),
    setTimeout: source.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)),
    clearTimeout: source.clearTimeout ?? ((timer) => clearTimeout(timer)),
  };
  if (typeof clock.now !== "function" || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") {
    throw workerError("kiro_organization_clock_invalid", "Kiro organization worker clock is invalid");
  }
  return clock;
}

function boundedInteger(value, fallback, min, max, code) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw workerError(code, "Kiro organization worker numeric option is invalid");
  }
  return candidate;
}

function defaultHomeRoot(environment, platform) {
  const api = pathApi(platform);
  if (platform === "win32") {
    const base = environment.LOCALAPPDATA ?? environment.USERPROFILE;
    return isLocalAbsolutePath(base, platform) ? api.join(base, "Kyrei", "kiro-organizations") : null;
  }
  if (isLocalAbsolutePath(environment.XDG_STATE_HOME, platform)) {
    return api.join(environment.XDG_STATE_HOME, "kyrei", "kiro-organizations");
  }
  return isLocalAbsolutePath(environment.HOME, platform)
    ? api.join(environment.HOME, ".local", "state", "kyrei", "kiro-organizations")
    : null;
}

function parseVersion(output) {
  const matches = String(output)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*kiro-cli(?:-chat)?\s+v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})(-[0-9A-Za-z.-]{1,80})?\s*$/i))
    .filter(Boolean);
  if (matches.length !== 1) {
    throw workerError("kiro_organization_cli_version_invalid", "Kiro CLI returned an invalid or ambiguous version");
  }
  const [match] = matches;
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
}

function versionSupported(version) {
  const minimum = [1, 28, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (version.parts[index] > minimum[index]) return true;
    if (version.parts[index] < minimum[index]) return false;
  }
  return !version.prerelease;
}

function normalizeAuthMarker(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function parseApiKeyWhoami(output) {
  let source;
  try {
    source = JSON.parse(String(output).trim());
  } catch {
    throw workerError("kiro_organization_whoami_invalid", "Kiro CLI returned invalid authentication JSON");
  }
  if (!source || typeof source !== "object" || Array.isArray(source) || source.authenticated === false) {
    throw workerError("kiro_organization_credential_rejected", "Kiro CLI did not authenticate the organization API key");
  }
  const markers = [
    source.accountType,
    source.provider,
    source.method,
    source.authMethod,
    source.authenticationMethod,
    source.credentialType,
  ].map(normalizeAuthMarker);
  if (!markers.includes("apikey")) {
    throw workerError("kiro_organization_credential_rejected", "Kiro CLI did not confirm API-key authentication");
  }
  return { verified: true, method: "api-key" };
}

function normalizedModelName(value, id) {
  if (value === undefined || value === null || value === "") return id;
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length > MAX_MODEL_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw workerError("kiro_organization_model_name_invalid", "Kiro CLI returned an invalid model name");
  }
  return value;
}

function containsCredential(value, credential) {
  const pending = [value];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    visited += 1;
    if (visited > 16_384) {
      throw workerError("kiro_organization_models_invalid", "Kiro CLI returned an unsupported model payload");
    }
    if (typeof current === "string") {
      if (current.includes(credential)) return true;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current && typeof current === "object") pending.push(...Object.values(current));
  }
  return false;
}

function parseModels(output, credential) {
  let payload;
  try {
    payload = JSON.parse(String(output).trim());
  } catch {
    throw workerError("kiro_organization_models_invalid", "Kiro CLI returned invalid model JSON");
  }
  if (containsCredential(payload, credential)) {
    throw workerError(
      "kiro_organization_credential_reflected",
      "Kiro CLI returned unsafe model metadata",
    );
  }
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.availableModels)
        ? payload.availableModels
        : null;
  if (!rows || rows.length > MAX_MODELS) {
    throw workerError(
      rows ? "kiro_organization_models_limit" : "kiro_organization_models_invalid",
      rows ? "Kiro CLI returned too many models" : "Kiro CLI returned an unsupported model payload",
    );
  }

  const seen = new Set();
  const models = [];
  for (const row of rows) {
    let id;
    let name;
    if (typeof row === "string") {
      id = row;
    } else if (row && typeof row === "object" && !Array.isArray(row)) {
      const idFields = ["id", "modelId", "model_id"].filter((key) => Object.hasOwn(row, key));
      if (!idFields.length) throw workerError("kiro_organization_model_id_missing", "Kiro CLI returned a model without an id");
      const ids = idFields.map((key) => row[key]);
      if (new Set(ids).size !== 1) {
        throw workerError("kiro_organization_model_id_invalid", "Kiro CLI returned conflicting model ids");
      }
      [id] = ids;
      name = row.displayName ?? row.name ?? row.model_name;
    } else {
      throw workerError("kiro_organization_models_invalid", "Kiro CLI returned an invalid model row");
    }
    if (!isValidKiroModelId(id)) {
      throw workerError("kiro_organization_model_id_invalid", "Kiro CLI returned an invalid model id");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: normalizedModelName(name, id) });
  }
  return { models, count: models.length };
}

export class KiroOrganizationWorker {
  constructor({
    executable,
    resolveExecutable = resolveKiroCliExecutable,
    spawn = nodeSpawn,
    clock,
    fs = {
      chmod: nodeChmod,
      lstat: nodeLstat,
      mkdir: nodeMkdir,
      realpath: nodeRealpath,
    },
    environment = process.env,
    platform = process.platform,
    homeRoot,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {}) {
    if (typeof resolveExecutable !== "function") throw workerError("kiro_organization_cli_resolver_invalid", "Kiro CLI resolver is invalid");
    if (typeof spawn !== "function") throw workerError("kiro_organization_spawn_invalid", "Kiro organization spawn implementation is invalid");
    if (
      !fs
      || typeof fs !== "object"
      || typeof fs.chmod !== "function"
      || typeof fs.lstat !== "function"
      || typeof fs.mkdir !== "function"
      || typeof fs.realpath !== "function"
    ) {
      throw workerError("kiro_organization_fs_invalid", "Kiro organization filesystem implementation is invalid");
    }
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw workerError("kiro_organization_environment_invalid", "Kiro organization environment is invalid");
    }
    this.platform = platform;
    this.environment = { ...environment };
    this.childEnvironment = buildKiroCliEnvironment(environment, { platform });
    for (const key of Object.keys(this.childEnvironment)) {
      if (key.toUpperCase().startsWith("AWS_") || PROFILE_ENV_KEYS.has(key.toUpperCase())) {
        delete this.childEnvironment[key];
      }
    }
    this.resolveExecutable = resolveExecutable;
    this.executable = executable === undefined ? null : validateExecutable(executable, platform);
    this.spawn = spawn;
    this.clock = validateClock(clock);
    this.fs = fs;
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000, "kiro_organization_timeout_invalid");
    this.terminationGraceMs = boundedInteger(
      terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      100,
      10_000,
      "kiro_organization_termination_grace_invalid",
    );
    this.maxOutputBytes = boundedInteger(
      maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      1_024,
      1_048_576,
      "kiro_organization_output_limit_invalid",
    );
    const root = homeRoot ?? defaultHomeRoot(environment, platform);
    if (!isLocalAbsolutePath(root, platform)) {
      throw workerError("kiro_organization_home_root_invalid", "Kiro organization home root must be an absolute local path");
    }
    this.homeRoot = pathApi(platform).normalize(root);
    this.active = new Set();
    this.accountProcesses = new Map();
    this.accountQueues = new Map();
    this.closePromise = null;
    this.closed = false;
  }

  _assertOpen() {
    if (this.closed) throw workerError("kiro_organization_worker_closed", "Kiro organization worker is closed");
  }

  _resolvedExecutable() {
    if (this.executable) return this.executable;
    let candidate;
    try {
      candidate = this.resolveExecutable({ platform: this.platform, environment: { ...this.environment } });
    } catch {
      throw workerError("kiro_organization_cli_not_found", "Official Kiro CLI is not available");
    }
    if (candidate && typeof candidate.then === "function") {
      throw workerError("kiro_organization_cli_resolver_invalid", "Kiro CLI resolver must be synchronous");
    }
    if (!candidate) throw workerError("kiro_organization_cli_not_found", "Official Kiro CLI is not installed");
    this.executable = validateExecutable(candidate, this.platform);
    return this.executable;
  }

  _accountHome(accountId) {
    const id = validateKiroOrganizationAccountId(accountId);
    const api = pathApi(this.platform);
    const home = api.normalize(api.join(this.homeRoot, id));
    const relative = api.relative(this.homeRoot, home);
    if (!relative || relative.startsWith("..") || api.isAbsolute(relative)) {
      throw workerError("kiro_organization_account_home_invalid", "Kiro organization account home is invalid");
    }
    return home;
  }

  async _secureDirectory(directory, realRoot = null) {
    let stats;
    let resolved;
    try {
      stats = await this.fs.lstat(directory);
      resolved = pathApi(this.platform).normalize(await this.fs.realpath(directory));
    } catch {
      throw workerError("kiro_organization_account_home_unavailable", "Kiro organization account home is unavailable");
    }
    const reparsePoint = typeof stats?.isReparsePoint === "function" && stats.isReparsePoint();
    if (
      !stats
      || typeof stats.isDirectory !== "function"
      || !stats.isDirectory()
      || (typeof stats.isSymbolicLink === "function" && stats.isSymbolicLink())
      || reparsePoint
      || !isLocalAbsolutePath(resolved, this.platform)
    ) {
      throw workerError("kiro_organization_account_home_unsafe", "Kiro organization account home failed its containment check");
    }
    if (realRoot) {
      const api = pathApi(this.platform);
      const relative = api.relative(realRoot, resolved);
      if (!relative || relative.startsWith("..") || api.isAbsolute(relative)) {
        throw workerError("kiro_organization_account_home_unsafe", "Kiro organization account home failed its containment check");
      }
    }
    if (this.platform !== "win32") {
      try {
        await this.fs.chmod(directory, 0o700);
      } catch {
        throw workerError("kiro_organization_account_home_unavailable", "Kiro organization account home permissions could not be enforced");
      }
    }
    return resolved;
  }

  async _prepareAccount(accountId) {
    const home = this._accountHome(accountId);
    const api = pathApi(this.platform);
    const directories = this.platform === "win32"
      ? [
          home,
          api.join(home, "AppData"),
          api.join(home, "AppData", "Local"),
          api.join(home, "AppData", "Roaming"),
          api.join(home, "tmp"),
        ]
      : [
          home,
          api.join(home, ".config"),
          api.join(home, ".cache"),
          api.join(home, ".local"),
          api.join(home, ".local", "share"),
          api.join(home, ".local", "state"),
          api.join(home, ".runtime"),
          api.join(home, "tmp"),
        ];
    try {
      await this.fs.mkdir(this.homeRoot, { recursive: true, mode: 0o700 });
    } catch {
      throw workerError("kiro_organization_account_home_unavailable", "Kiro organization account home is unavailable");
    }
    const realRoot = await this._secureDirectory(this.homeRoot);
    for (const directory of directories) {
      try {
        await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
      } catch {
        throw workerError("kiro_organization_account_home_unavailable", "Kiro organization account home is unavailable");
      }
      await this._secureDirectory(directory, realRoot);
    }
    return home;
  }

  _isolatedEnvironment(accountHome, apiKey) {
    const api = pathApi(this.platform);
    const temporary = api.join(accountHome, "tmp");
    const profile = this.platform === "win32"
      ? {
          HOME: accountHome,
          USERPROFILE: accountHome,
          LOCALAPPDATA: api.join(accountHome, "AppData", "Local"),
          APPDATA: api.join(accountHome, "AppData", "Roaming"),
          TEMP: temporary,
          TMP: temporary,
        }
      : {
          HOME: accountHome,
          XDG_CONFIG_HOME: api.join(accountHome, ".config"),
          XDG_CACHE_HOME: api.join(accountHome, ".cache"),
          XDG_DATA_HOME: api.join(accountHome, ".local", "share"),
          XDG_STATE_HOME: api.join(accountHome, ".local", "state"),
          XDG_RUNTIME_DIR: api.join(accountHome, ".runtime"),
          TEMP: temporary,
          TMP: temporary,
          TMPDIR: temporary,
        };
    return {
      ...this.childEnvironment,
      ...profile,
      KIRO_HOME: accountHome,
      NO_COLOR: "1",
      ...(apiKey ? { KIRO_API_KEY: apiKey } : {}),
    };
  }

  _run(args, {
    accountId,
    accountHome,
    apiKey,
    signal,
    timeoutMs = this.timeoutMs,
    maxOutputBytes = this.maxOutputBytes,
  } = {}) {
    this._assertOpen();
    const id = validateKiroOrganizationAccountId(accountId);
    if (this.accountProcesses.has(id)) {
      throw workerError("kiro_organization_account_process_active", "A Kiro CLI process is already active for this account");
    }
    const executable = this._resolvedExecutable();
    const env = this._isolatedEnvironment(accountHome, apiKey);
    let child;
    try {
      child = this.spawn(executable, args, {
        shell: false,
        windowsHide: true,
        cwd: pathApi(this.platform).dirname(executable),
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch {
      throw workerError("kiro_organization_cli_start_failed", "Official Kiro CLI could not start");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let exitConfirmed = false;
      let terminationError = null;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let timer;
      let terminationTimer;
      let resolveExit;
      const exited = new Promise((resolveLifecycle) => { resolveExit = resolveLifecycle; });
      const record = { child, accountId: id, cancel: null, exited };
      this.active.add(record);
      this.accountProcesses.set(id, record);

      const removeDataListeners = () => {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) this.clock.clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        removeDataListeners();
        if (error) reject(error);
        else resolve(result);
      };
      const confirmExit = () => {
        if (exitConfirmed) return;
        exitConfirmed = true;
        if (terminationTimer) this.clock.clearTimeout(terminationTimer);
        this.active.delete(record);
        if (this.accountProcesses.get(id) === record) this.accountProcesses.delete(id);
        resolveExit();
        if (terminationError) finish(terminationError);
      };
      const requestTermination = (error) => {
        if (terminationError) return;
        terminationError = error;
        if (timer) this.clock.clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        removeDataListeners();
        try { child.kill("SIGKILL"); } catch { /* grace timer keeps the account quarantined */ }
        if (exitConfirmed) {
          finish(error);
          return;
        }
        terminationTimer = this.clock.setTimeout(() => {
          terminationTimer = undefined;
          if (exitConfirmed) return;
          child.stdout?.resume?.();
          child.stderr?.resume?.();
          finish(workerError(
            "kiro_organization_cli_termination_unconfirmed",
            "Kiro CLI termination could not be confirmed",
          ));
        }, this.terminationGraceMs);
      };
      const append = (channel, chunk) => {
        if (settled || terminationError) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        outputBytes += Buffer.byteLength(text, "utf8");
        if (outputBytes > maxOutputBytes) {
          requestTermination(
            workerError("kiro_organization_cli_output_limit", "Kiro CLI output exceeded the configured limit"),
          );
          return;
        }
        if (channel === "stdout") stdout += text;
        else stderr += text;
      };
      const onStdout = (chunk) => append("stdout", chunk);
      const onStderr = (chunk) => append("stderr", chunk);
      const onAbort = () => requestTermination(
        workerError("kiro_organization_operation_aborted", "Kiro organization operation was aborted"),
      );
      record.cancel = onAbort;

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", (error) => {
        if (terminationError) return;
        const code = error?.code === "ENOENT"
          ? "kiro_organization_cli_not_found"
          : "kiro_organization_cli_start_failed";
        const failure = workerError(code, code === "kiro_organization_cli_not_found"
          ? "Official Kiro CLI is not installed"
          : "Official Kiro CLI could not start");
        if (child.pid === undefined || child.pid === null) {
          confirmExit();
          finish(failure);
        } else {
          requestTermination(failure);
        }
      });
      child.once("exit", confirmExit);
      child.once("close", (code) => {
        confirmExit();
        if (terminationError) return;
        if (code === 0) finish(null, { stdout, stderr });
        else finish(workerError("kiro_organization_cli_command_failed", "Official Kiro CLI command failed"));
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      timer = this.clock.setTimeout(() => requestTermination(
        workerError("kiro_organization_cli_timeout", "Official Kiro CLI command timed out"),
      ), timeoutMs);
    });
  }

  async _checkedVersion(accountId, accountHome, signal) {
    const result = await this._run(["--version"], {
      accountId,
      accountHome,
      signal,
      timeoutMs: Math.min(this.timeoutMs, 10_000),
      maxOutputBytes: Math.min(this.maxOutputBytes, 32_000),
    });
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (!versionSupported(version)) {
      throw workerError(
        "kiro_organization_cli_version_unsupported",
        `Kiro CLI ${KIRO_ORGANIZATION_MINIMUM_CLI_VERSION} or newer is required`,
      );
    }
    return version.text;
  }

  async _withAccountLock(accountId, signal, operation) {
    const previous = this.accountQueues.get(accountId) ?? Promise.resolve();
    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.accountQueues.set(accountId, tail);
    await previous.catch(() => {});
    try {
      this._assertOpen();
      if (signal?.aborted) {
        throw workerError("kiro_organization_operation_aborted", "Kiro organization operation was aborted");
      }
      return await operation();
    } finally {
      const release = () => {
        unlock();
        if (this.accountQueues.get(accountId) === tail) this.accountQueues.delete(accountId);
      };
      const activeProcess = this.accountProcesses.get(accountId);
      if (activeProcess) activeProcess.exited.then(release);
      else release();
    }
  }

  async verifyAccount({ accountId, apiKey, signal } = {}) {
    this._assertOpen();
    const id = validateKiroOrganizationAccountId(accountId);
    const secret = normalizeKiroOrganizationAccountSecret({ apiKey });
    return this._withAccountLock(id, signal, async () => {
      const accountHome = await this._prepareAccount(id);
      const cliVersion = await this._checkedVersion(id, accountHome, signal);
      const result = await this._run(["whoami", "--format", "json"], {
        accountId: id,
        accountHome,
        apiKey: secret.apiKey,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 15_000),
        maxOutputBytes: Math.min(this.maxOutputBytes, 64_000),
      });
      return { ...parseApiKeyWhoami(result.stdout), cliVersion };
    });
  }

  async discoverModels({ accountId, apiKey, signal } = {}) {
    this._assertOpen();
    const id = validateKiroOrganizationAccountId(accountId);
    const secret = normalizeKiroOrganizationAccountSecret({ apiKey });
    return this._withAccountLock(id, signal, async () => {
      const accountHome = await this._prepareAccount(id);
      await this._checkedVersion(id, accountHome, signal);
      const result = await this._run(["chat", "--list-models", "--format", "json"], {
        accountId: id,
        accountHome,
        apiKey: secret.apiKey,
        signal,
      });
      return parseModels(result.stdout, secret.apiKey);
    });
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const records = [...this.active];
    this.closePromise = (async () => {
      for (const record of records) record.cancel?.();
      await Promise.all(records.map((record) => record.exited));
    })();
    return this.closePromise;
  }
}
