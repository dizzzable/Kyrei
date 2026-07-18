/**
 * Workspace-owned MCP configuration.
 *
 * Global MCP servers remain in Kyrei's user configuration. A project may add
 * its own list in `.kyrei/mcp.json`; that file is data from the repository and
 * is never activated until the user explicitly trusts this workspace.
 */

import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";

export const PROJECT_MCP_RELATIVE_PATH = ".kyrei/mcp.json";
const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;
const MAX_PROJECT_SERVERS = 16;

export const EMPTY_PROJECT_MCP_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  servers: [],
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedServerId(value) {
  return typeof value === "string"
    ? value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
    : "";
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && path !== "..");
}

async function ownedProjectMcpPath(workspace, { createRoot = false } = {}) {
  if (typeof workspace !== "string" || !workspace.trim()) {
    const error = new Error("workspace_not_configured");
    error.code = "workspace_not_configured";
    throw error;
  }
  const workspaceRoot = await realpath(workspace);
  const kyreiPath = join(workspaceRoot, ".kyrei");
  let kyreiStat = await lstat(kyreiPath).catch(() => null);
  if (!kyreiStat && createRoot) {
    await mkdir(kyreiPath, { recursive: true });
    kyreiStat = await lstat(kyreiPath).catch(() => null);
  }
  if (!kyreiStat?.isDirectory() || kyreiStat.isSymbolicLink()) {
    const error = new Error("project_mcp_root_unavailable");
    error.code = "project_mcp_root_unavailable";
    throw error;
  }
  const kyreiRoot = await realpath(kyreiPath);
  if (!isInside(workspaceRoot, kyreiRoot)) {
    const error = new Error("project_mcp_root_outside_workspace");
    error.code = "project_mcp_root_outside_workspace";
    throw error;
  }
  return { workspace: workspaceRoot, path: join(kyreiRoot, "mcp.json") };
}

/** Keep portable project data small and JSON-only. Runtime validation remains
 * in the engine MCP normalizer so diagnostics can report one bad server rather
 * than discard a user's entire file. */
export function normalizeProjectMcpConfig(raw) {
  const source = isRecord(raw) ? raw : {};
  const seen = new Set();
  const servers = [];
  const input = Array.isArray(source.servers) ? source.servers : [];
  for (const candidate of input) {
    if (!isRecord(candidate)) continue;
    const id = normalizedServerId(candidate.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // JSON round-tripping strips prototypes and makes the on-disk document
    // deterministic. Bounds avoid a project file becoming an unbounded UI or
    // engine input before the engine's stricter config boundary runs.
    const copy = JSON.parse(JSON.stringify(candidate));
    copy.id = id;
    servers.push(copy);
    if (servers.length >= MAX_PROJECT_SERVERS) break;
  }
  return {
    version: 1,
    enabled: source.enabled === true,
    servers,
  };
}

export async function readProjectMcpConfig(workspace) {
  const owned = await ownedProjectMcpPath(workspace);
  try {
    const info = await lstat(owned.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROJECT_CONFIG_BYTES) {
      return { ...owned, exists: true, valid: false, config: { ...EMPTY_PROJECT_MCP_CONFIG }, error: "project_mcp_file_invalid" };
    }
    const parsed = JSON.parse(await readFile(owned.path, "utf8"));
    if (!isRecord(parsed)) throw new Error("project_mcp_json_invalid");
    return { ...owned, exists: true, valid: true, config: normalizeProjectMcpConfig(parsed) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ...owned, exists: false, valid: true, config: { ...EMPTY_PROJECT_MCP_CONFIG } };
    }
    return {
      ...owned,
      exists: true,
      valid: false,
      config: { ...EMPTY_PROJECT_MCP_CONFIG },
      error: error?.message === "project_mcp_json_invalid" ? "project_mcp_json_invalid" : "project_mcp_file_invalid",
    };
  }
}

export async function writeProjectMcpConfig(workspace, raw) {
  const owned = await ownedProjectMcpPath(workspace, { createRoot: true });
  const config = normalizeProjectMcpConfig(raw);
  const temp = join(owned.workspace, ".kyrei", `.mcp.json.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temp, owned.path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  return { ...owned, exists: true, valid: true, config };
}

/**
 * Project entries override global entries with the same id. A disabled
 * project entry intentionally masks its global peer for this workspace.
 * Only global settings own timeouts/limits and the master enable switch.
 */
export function mergeMcpScopes(globalRaw, projectSnapshot, { projectTrusted = false } = {}) {
  const global = isRecord(globalRaw) ? globalRaw : {};
  const project = projectSnapshot?.valid && isRecord(projectSnapshot.config)
    ? projectSnapshot.config
    : EMPTY_PROJECT_MCP_CONFIG;
  const projectIsActive = projectTrusted && project.enabled === true;
  const projectEntries = projectIsActive && Array.isArray(project.servers) ? project.servers : [];
  const overriddenIds = new Set(projectEntries.map((server) => normalizedServerId(server?.id)).filter(Boolean));
  const globalEntries = Array.isArray(global.servers) ? global.servers : [];
  const globalServers = globalEntries
    .filter((server) => !overriddenIds.has(normalizedServerId(server?.id)))
    .map((server) => ({ ...server, source: "global" }));
  const projectServers = projectEntries.map((server) => ({ ...server, source: "project" }));
  return {
    ...global,
    enabled: global.enabled === true,
    servers: [...globalServers, ...projectServers].slice(0, 16),
  };
}
