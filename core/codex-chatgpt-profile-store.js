/**
 * Filesystem boundary for isolated official Codex ChatGPT profiles.
 *
 * The store never reads auth.json or any credential file.  It only prepares a
 * fixed, private CODEX_HOME and asks the official runtime to perform account
 * operations through its JSON-RPC API.
 */

import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateNewCodexChatgptPoolAccount } from "./codex-chatgpt-pool-config.js";

export class CodexChatgptProfileStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CodexChatgptProfileStoreError";
    this.code = code;
  }
}

function error(code) {
  return new CodexChatgptProfileStoreError(code);
}

function accountId(value) {
  // Reuse the public config validator with an empty pool so profile paths can
  // never be created from a raw route parameter.
  return validateNewCodexChatgptPoolAccount({ id: value, name: "profile" }, { accounts: [] }).id;
}

function isContained(root, target) {
  const relation = relative(root, target);
  return Boolean(relation) && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

export class CodexChatgptProfileStore {
  constructor({ homeRoot, connectorFactory } = {}) {
    if (typeof homeRoot !== "string" || !homeRoot || homeRoot.includes("\0")) {
      throw error("codex_chatgpt_profile_root_invalid");
    }
    if (typeof connectorFactory !== "function") throw error("codex_chatgpt_profile_connector_factory_invalid");
    this.homeRoot = resolve(homeRoot);
    this.connectorFactory = connectorFactory;
    this.connectors = new Map();
  }

  profilePath(value) {
    const id = accountId(value);
    const target = resolve(this.homeRoot, id);
    if (!isContained(this.homeRoot, target)) {
      throw error("codex_chatgpt_profile_path_invalid");
    }
    return target;
  }

  async verifiedRoot() {
    await mkdir(this.homeRoot, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.homeRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw error("codex_chatgpt_profile_root_invalid");
    if (process.platform !== "win32") await chmod(this.homeRoot, 0o700);
    return realpath(this.homeRoot);
  }

  async verifiedProfile(value, { create = false } = {}) {
    const target = this.profilePath(value);
    const root = await this.verifiedRoot();
    try {
      const stats = await lstat(target);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw error("codex_chatgpt_profile_path_invalid");
    } catch (cause) {
      if (cause?.code !== "ENOENT" || !create) throw cause;
      await mkdir(target, { recursive: false, mode: 0o700 });
      const stats = await lstat(target);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw error("codex_chatgpt_profile_path_invalid");
    }
    const resolvedTarget = await realpath(target);
    if (!isContained(root, resolvedTarget)) throw error("codex_chatgpt_profile_path_invalid");
    if (process.platform !== "win32") await chmod(resolvedTarget, 0o700);
    return resolvedTarget;
  }

  async verifiedConfigPath(profilePath) {
    const configPath = resolve(profilePath, "config.toml");
    if (!isContained(profilePath, configPath)) throw error("codex_chatgpt_profile_path_invalid");
    try {
      const stats = await lstat(configPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw error("codex_chatgpt_profile_path_invalid");
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    return configPath;
  }

  async ensureProfile(value) {
    const target = await this.verifiedProfile(value, { create: true });
    // Pin the official runtime to profile-local credential storage.  This is a
    // Kyrei-owned fresh profile, so there is no user configuration to merge.
    const configPath = await this.verifiedConfigPath(target);
    try {
      await writeFile(configPath, 'cli_auth_credentials_store = "file"\n', {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
    }
    await this.verifiedConfigPath(target);
    if (process.platform !== "win32") await chmod(configPath, 0o600);
    return target;
  }

  async connectorFor(value) {
    const id = accountId(value);
    const existing = this.connectors.get(id);
    if (existing) return existing;
    const codexHome = await this.ensureProfile(id);
    const connector = this.connectorFactory({ accountId: id, codexHome });
    if (!connector || typeof connector.status !== "function" || typeof connector.startLogin !== "function") {
      throw error("codex_chatgpt_profile_connector_invalid");
    }
    this.connectors.set(id, connector);
    return connector;
  }

  /** Remove only a validated, Kyrei-owned profile directory after logout. */
  async removeProfile(value) {
    const id = accountId(value);
    const connector = this.connectors.get(id);
    await Promise.resolve(connector?.close?.()).catch(() => undefined);
    this.connectors.delete(id);
    let target;
    try {
      target = await this.verifiedProfile(id);
    } catch (cause) {
      if (cause?.code === "ENOENT") return;
      throw cause;
    }
    // `profilePath` resolves a strict account-id child of homeRoot.  Never
    // accept a caller-provided directory or glob for a recursive removal.
    await rm(target, { recursive: true, force: true, maxRetries: 2 });
  }

  async close() {
    await Promise.all([...this.connectors.values()].map((connector) => Promise.resolve(connector.close?.()).catch(() => undefined)));
    this.connectors.clear();
  }
}
