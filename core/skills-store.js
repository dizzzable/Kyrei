import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SKILLS_STATE_VERSION = 1;

const STATE_FILE = "skills-state.json";
const SKILL_FILE = "SKILL.md";
const DEFAULT_MAX_SKILL_BYTES = 256_000;
const HARD_MAX_SKILL_BYTES = 2_000_000;
const HARD_MAX_RUNTIME_SKILLS = 256;
const HARD_MAX_RUNTIME_CHARS = 1_000_000;
const MAX_FRONTMATTER_CHARS = 16_384;
const MAX_FRONTMATTER_LINES = 128;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_METADATA_TEXT_CHARS = 512;
const MAX_TAGS = 32;
const PUBLIC_ID_RE = /^skill_[a-f0-9]{24}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ALLOWED_METADATA_KEYS = new Set(["name", "description", "version", "author", "tags"]);

export class SkillsStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SkillsStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillsStoreError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathKey(value) {
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stableHash(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableSkillId(canonicalFile) {
  return `skill_${stableHash(pathKey(canonicalFile))}`;
}

function stableRootId(provenance, canonicalRoot) {
  if (provenance === "global") return "global";
  return `${provenance}_${stableHash(pathKey(canonicalRoot), 16)}`;
}

function isPathInside(root, candidate, allowRoot = true) {
  const rel = relative(root, candidate);
  if (!rel) return allowRoot;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pathsOverlap(left, right) {
  return isPathInside(left, right, true) || isPathInside(right, left, true);
}

function assertSafeName(value) {
  if (typeof value !== "string" || !SAFE_NAME_RE.test(value) || RESERVED_WINDOWS_NAMES.test(value)) {
    fail("invalid_skill_name", "Skill names must be 1-64 letters, numbers, underscores, or hyphens and start with a letter or number");
  }
  return value;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (!value || /^[!&*]/.test(value)) return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  // Comments are removed only when separated by whitespace, so values such as
  // `C#` and URLs with fragments remain intact.
  return value.replace(/\s+#.*$/, "").trim();
}

function parseTags(value) {
  const raw = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const tags = [];
  for (const part of raw.split(",")) {
    const tag = cleanText(parseScalar(part), 64);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * Parse only the small, inert metadata subset Kyrei understands. This is not a
 * general YAML parser: tags, anchors, aliases, objects, and executable values
 * are intentionally ignored. The returned object always has a normal, clean
 * prototype and cannot be polluted by frontmatter keys.
 */
export function parseSkillFrontmatter(source) {
  const text = typeof source === "string" ? source.replace(/^\uFEFF/, "") : "";
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: text, metadata: {} };

  let closing = -1;
  let scannedChars = 0;
  for (let index = 1; index < Math.min(lines.length, MAX_FRONTMATTER_LINES + 1); index += 1) {
    scannedChars += lines[index]?.length ?? 0;
    if (scannedChars > MAX_FRONTMATTER_CHARS) break;
    if (lines[index]?.trim() === "---") {
      closing = index;
      break;
    }
  }
  if (closing < 0) return { body: text, metadata: {} };

  const metadata = {};
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,31}):(?:\s*(.*))?$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!ALLOWED_METADATA_KEYS.has(key) || Object.hasOwn(metadata, key)) continue;
    let rawValue = match[2] ?? "";

    if ((rawValue === "|" || rawValue === ">") && key === "description") {
      const folded = rawValue === ">";
      const chunks = [];
      while (index + 1 < closing && /^\s+/.test(lines[index + 1] ?? "")) {
        index += 1;
        chunks.push((lines[index] ?? "").replace(/^\s+/, ""));
      }
      rawValue = chunks.join(folded ? " " : "\n");
    }

    if (key === "tags") {
      const tags = parseTags(rawValue);
      if (tags.length) metadata.tags = tags;
      continue;
    }
    const max = key === "description" ? MAX_DESCRIPTION_CHARS : MAX_METADATA_TEXT_CHARS;
    const parsed = cleanText(parseScalar(rawValue), max);
    if (parsed) metadata[key] = parsed;
  }

  return { body: lines.slice(closing + 1).join("\n"), metadata };
}

function descriptionFromBody(body) {
  const lines = body.split(/\r?\n/);
  const paragraph = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (/^(?:#|```|~~~|<!--)/.test(line)) continue;
    paragraph.push(line);
    if (paragraph.join(" ").length >= 280) break;
  }
  return cleanText(paragraph.join(" "), 280);
}

function normalizeUsage(value) {
  if (!isRecord(value)) return null;
  const total = Number.isSafeInteger(value.total) && value.total >= 0 ? value.total : 0;
  const lastUsedAt = typeof value.lastUsedAt === "string" && !Number.isNaN(Date.parse(value.lastUsedAt))
    ? value.lastUsedAt
    : undefined;
  return total || lastUsedAt ? { total, ...(lastUsedAt ? { lastUsedAt } : {}) } : null;
}

function normalizeState(value) {
  const source = isRecord(value) ? value : {};
  const roots = Array.isArray(source.customRoots) ? source.customRoots : [];
  const customRoots = [];
  const seenRoots = new Set();
  for (const candidate of roots) {
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) continue;
    const normalized = resolve(candidate);
    const key = pathKey(normalized);
    if (!seenRoots.has(key)) {
      seenRoots.add(key);
      customRoots.push(normalized);
    }
  }

  const disabledIds = [];
  const disabledSeen = new Set();
  const rawDisabled = Array.isArray(source.disabledIds) ? source.disabledIds : [];
  for (const id of rawDisabled) {
    if (typeof id === "string" && PUBLIC_ID_RE.test(id) && !disabledSeen.has(id)) {
      disabledSeen.add(id);
      disabledIds.push(id);
    }
  }

  const usage = {};
  if (isRecord(source.usage)) {
    for (const [id, record] of Object.entries(source.usage)) {
      if (!PUBLIC_ID_RE.test(id)) continue;
      const normalized = normalizeUsage(record);
      if (normalized) usage[id] = normalized;
    }
  }

  return { version: SKILLS_STATE_VERSION, customRoots, disabledIds, usage };
}

async function pathInfoNoSymlink(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
    return info;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function secureDirectory(path) {
  const info = await pathInfoNoSymlink(path);
  if (!info?.isDirectory()) return null;
  try {
    return await realpath(path);
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    throw error;
  }
}

async function canonicalDirectChild(parentCanonical, childPath) {
  const canonical = await secureDirectory(childPath);
  if (!canonical || !isPathInside(parentCanonical, canonical, false)) return null;
  const rel = relative(parentCanonical, canonical);
  return rel.includes(sep) ? null : canonical;
}

async function inspectWorkspaceSkillsRoot(workspace) {
  const workspacePath = resolve(workspace);
  const workspaceCanonical = await secureDirectory(workspacePath);
  if (!workspaceCanonical) return null;

  // Validate every owned component independently. Checking only the final
  // `skills` entry misses a junction/symlink at `.kyrei` on Windows and POSIX.
  const kyreiPath = join(workspaceCanonical, ".kyrei");
  const kyreiCanonical = await canonicalDirectChild(workspaceCanonical, kyreiPath);
  if (!kyreiCanonical) return null;
  const skillsPath = join(kyreiCanonical, "skills");
  const skillsCanonical = await canonicalDirectChild(kyreiCanonical, skillsPath);
  if (!skillsCanonical) return null;

  return { workspaceCanonical, kyreiCanonical, skillsCanonical };
}

async function ensureDirectoryComponent(path) {
  try {
    await mkdir(path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

async function readSkillFile(path, containmentRoot, maxBytes) {
  const info = await pathInfoNoSymlink(path);
  if (!info?.isFile() || info.size > maxBytes) return null;
  const canonical = await realpath(path);
  if (!isPathInside(containmentRoot, canonical, false)) return null;

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.size > maxBytes) return null;
    return { canonical, content: await handle.readFile("utf8") };
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(path, content) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function publicRoot(root) {
  return {
    id: root.id,
    path: root.path,
    provenance: root.provenance,
    owned: root.owned,
    available: root.available,
  };
}

function publicSkill(skill, includeContent = false) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    provenance: skill.provenance,
    owned: skill.owned,
    enabled: skill.enabled,
    usage: skill.usage,
    ...(skill.lastUsedAt ? { lastUsedAt: skill.lastUsedAt } : {}),
    rootId: skill.rootId,
    relativePath: skill.relativePath,
    metadata: { ...skill.metadata },
    ...(includeContent ? { content: skill.content } : {}),
  };
}

function renderSkillDocument({ name, description, content, metadata }) {
  const cleanDescription = cleanText(description, MAX_DESCRIPTION_CHARS);
  const version = cleanText(metadata?.version, MAX_METADATA_TEXT_CHARS);
  const author = cleanText(metadata?.author, MAX_METADATA_TEXT_CHARS);
  const tags = Array.isArray(metadata?.tags)
    ? metadata.tags.map((tag) => cleanText(String(tag), 64)).filter(Boolean).slice(0, MAX_TAGS)
    : [];
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(name)}`,
    ...(cleanDescription ? [`description: ${JSON.stringify(cleanDescription)}`] : []),
    ...(version ? [`version: ${JSON.stringify(version)}`] : []),
    ...(author ? [`author: ${JSON.stringify(author)}`] : []),
    ...(tags.length ? [`tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`] : []),
    "---",
  ];
  const body = typeof content === "string" && content.trim() ? content.trim() : `# ${name}`;
  return `${frontmatter.join("\n")}\n\n${body}\n`;
}

export class SkillsStore {
  constructor({ dataDir, workspace = "", maxSkillBytes = DEFAULT_MAX_SKILL_BYTES } = {}) {
    if (typeof dataDir !== "string" || !dataDir.trim() || dataDir.includes("\0")) {
      fail("invalid_data_dir", "SkillsStore requires a dataDir");
    }
    this.dataDir = resolve(dataDir);
    this.globalRoot = join(this.dataDir, "skills");
    this.stateFile = join(this.dataDir, STATE_FILE);
    this.workspace = typeof workspace === "string" && workspace.trim() ? resolve(workspace) : "";
    this.maxSkillBytes = Math.max(1_024, Math.min(HARD_MAX_SKILL_BYTES, Number(maxSkillBytes) || DEFAULT_MAX_SKILL_BYTES));
    this.state = normalizeState({});
    this.loaded = false;
    this.loadPromise = null;
    this.mutationTail = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.#load().then(() => {
      this.loaded = true;
      return this;
    }).finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  async #load() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.globalRoot, { recursive: true });
    if (this.workspace) await this.#ensureWorkspaceRoot(this.workspace);

    let raw = null;
    try {
      raw = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) {
        const corrupt = `${this.stateFile}.corrupt-${Date.now()}`;
        await rename(this.stateFile, corrupt).catch(() => {});
      }
    }
    this.state = normalizeState(raw ?? {});
    await this.#persist();
  }

  async #persist() {
    const snapshot = JSON.stringify(normalizeState(this.state), null, 2) + "\n";
    await atomicWrite(this.stateFile, snapshot);
  }

  async #queueMutation(operation, persist = true) {
    await this.load();
    const run = this.mutationTail.then(async () => {
      const result = await operation();
      if (persist) await this.#persist();
      return result;
    });
    this.mutationTail = run.catch(() => {});
    return run;
  }

  async #settled() {
    await this.load();
    await this.mutationTail;
  }

  async #ensureWorkspaceRoot(workspace) {
    const root = resolve(workspace);
    const workspaceCanonical = await secureDirectory(root);
    if (!workspaceCanonical) fail("invalid_workspace", "Workspace must be an existing non-symlink directory");

    // Create one canonical component at a time. Recursive mkdir would follow a
    // pre-existing `.kyrei` junction and could create `skills` outside the
    // canonical workspace before validation had a chance to reject it.
    const kyreiPath = join(workspaceCanonical, ".kyrei");
    await ensureDirectoryComponent(kyreiPath);
    const kyreiCanonical = await canonicalDirectChild(workspaceCanonical, kyreiPath);
    if (!kyreiCanonical) fail("invalid_workspace", "Workspace .kyrei directory is not owned by the workspace");

    const skillsPath = join(kyreiCanonical, "skills");
    await ensureDirectoryComponent(skillsPath);
    const skillsCanonical = await canonicalDirectChild(kyreiCanonical, skillsPath);
    if (!skillsCanonical) fail("invalid_workspace", "Workspace skills directory is not owned by the workspace");

    const verified = await inspectWorkspaceSkillsRoot(root);
    if (!verified || pathKey(verified.skillsCanonical) !== pathKey(skillsCanonical)) {
      fail("invalid_workspace", "Workspace skills ownership changed during validation");
    }
    return skillsCanonical;
  }

  async setWorkspace(workspace = "") {
    return this.#queueMutation(async () => {
      if (workspace == null || workspace === "") {
        this.workspace = "";
        return this.rootsInternal();
      }
      if (typeof workspace !== "string" || !workspace.trim() || workspace.includes("\0")) {
        fail("invalid_workspace", "Workspace must be an existing directory");
      }
      const next = resolve(workspace);
      await this.#ensureWorkspaceRoot(next);
      this.workspace = next;
      return this.rootsInternal();
    }, false);
  }

  async #rootDescriptor(path, provenance, owned) {
    const canonical = await secureDirectory(path);
    return {
      id: stableRootId(provenance, canonical ?? path),
      path: canonical ?? resolve(path),
      canonical,
      provenance,
      owned,
      available: Boolean(canonical),
    };
  }

  async #workspaceRootDescriptor() {
    const configuredPath = join(this.workspace, ".kyrei", "skills");
    const inspected = await inspectWorkspaceSkillsRoot(this.workspace);
    if (!inspected) {
      return {
        id: stableRootId("workspace", configuredPath),
        path: resolve(configuredPath),
        canonical: null,
        provenance: "workspace",
        owned: false,
        available: false,
      };
    }
    return {
      id: stableRootId("workspace", inspected.skillsCanonical),
      path: inspected.skillsCanonical,
      canonical: inspected.skillsCanonical,
      provenance: "workspace",
      owned: true,
      available: true,
    };
  }

  async rootsInternal() {
    const roots = [await this.#rootDescriptor(this.globalRoot, "global", true)];
    if (this.workspace) {
      roots.push(await this.#workspaceRootDescriptor());
    }
    for (const path of this.state.customRoots) {
      roots.push(await this.#rootDescriptor(path, "custom", false));
    }
    return roots;
  }

  async roots() {
    await this.#settled();
    return (await this.rootsInternal()).map(publicRoot);
  }

  async #skillFromDirectory(root, skillDirectory) {
    const directoryInfo = await pathInfoNoSymlink(skillDirectory);
    if (!directoryInfo?.isDirectory()) return null;
    const canonicalDirectory = await realpath(skillDirectory);
    if (!isPathInside(root.canonical, canonicalDirectory, true)) return null;
    const loaded = await readSkillFile(join(skillDirectory, SKILL_FILE), canonicalDirectory, this.maxSkillBytes);
    if (!loaded) return null;

    const parsed = parseSkillFrontmatter(loaded.content);
    const fallbackName = basename(canonicalDirectory);
    const candidateName = parsed.metadata.name || fallbackName;
    if (!SAFE_NAME_RE.test(candidateName) || RESERVED_WINDOWS_NAMES.test(candidateName)) return null;
    const relativeDirectory = relative(root.canonical, canonicalDirectory);
    const relativePath = (relativeDirectory ? join(relativeDirectory, SKILL_FILE) : SKILL_FILE).replaceAll("\\", "/");
    const id = stableSkillId(loaded.canonical);
    const usage = normalizeUsage(this.state.usage[id]) ?? { total: 0 };

    return {
      id,
      name: candidateName,
      description: cleanText(parsed.metadata.description, MAX_DESCRIPTION_CHARS) || descriptionFromBody(parsed.body),
      provenance: root.provenance,
      owned: root.owned,
      enabled: !this.state.disabledIds.includes(id),
      usage: usage.total,
      lastUsedAt: usage.lastUsedAt,
      rootId: root.id,
      relativePath,
      metadata: {
        ...(parsed.metadata.version ? { version: parsed.metadata.version } : {}),
        ...(parsed.metadata.author ? { author: parsed.metadata.author } : {}),
        ...(parsed.metadata.tags ? { tags: [...parsed.metadata.tags] } : {}),
      },
      content: loaded.content,
      _rootCanonical: root.canonical,
      _skillDirectory: canonicalDirectory,
      _skillFile: loaded.canonical,
      _atRoot: canonicalDirectory === root.canonical,
    };
  }

  async #discover() {
    const found = [];
    const seenFiles = new Set();
    const roots = await this.rootsInternal();
    for (const root of roots) {
      if (!root.available || !root.canonical) continue;
      const candidates = [root.canonical];
      let entries = [];
      try {
        entries = await readdir(root.canonical, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(join(root.canonical, entry.name));
      }
      for (const candidate of candidates) {
        const skill = await this.#skillFromDirectory(root, candidate).catch(() => null);
        if (!skill) continue;
        const key = pathKey(skill._skillFile);
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        found.push(skill);
      }
    }
    const provenanceOrder = { workspace: 0, global: 1, custom: 2 };
    found.sort((left, right) =>
      (provenanceOrder[left.provenance] - provenanceOrder[right.provenance]) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id));
    return found;
  }

  async list() {
    await this.#settled();
    return (await this.#discover()).map((skill) => publicSkill(skill));
  }

  async get(id) {
    await this.#settled();
    if (typeof id !== "string" || !PUBLIC_ID_RE.test(id)) fail("skill_not_found", "Skill not found");
    const skill = (await this.#discover()).find((candidate) => candidate.id === id);
    if (!skill) fail("skill_not_found", "Skill not found");
    return publicSkill(skill, true);
  }

  async create({ name, description = "", content = "", metadata = {}, rootId = "global" } = {}) {
    return this.#queueMutation(async () => {
      const safeName = assertSafeName(name);
      const roots = await this.rootsInternal();
      const root = roots.find((candidate) =>
        candidate.id === rootId || (rootId === "workspace" && candidate.provenance === "workspace"));
      if (!root) fail("root_not_found", "Skills root not found");
      if (!root.owned) fail("root_not_owned", "Skills can only be created in owned roots");
      if (!root.available || !root.canonical) fail("root_unavailable", "Skills root is unavailable");

      const target = join(root.canonical, safeName);
      if (!isPathInside(root.canonical, target, false)) fail("path_escape", "Skill path escapes its root");
      if (await pathInfoNoSymlink(target)) fail("skill_exists", "A skill with this directory already exists");

      let document;
      const supplied = typeof content === "string" ? content : "";
      if (supplied.replace(/^\uFEFF/, "").startsWith("---\n") || supplied.replace(/^\uFEFF/, "").startsWith("---\r\n")) {
        const parsed = parseSkillFrontmatter(supplied);
        if (parsed.metadata.name && parsed.metadata.name !== safeName) {
          fail("invalid_skill_document", "Frontmatter name must match the requested skill name");
        }
        document = supplied.endsWith("\n") ? supplied : `${supplied}\n`;
      } else {
        document = renderSkillDocument({ name: safeName, description, content: supplied, metadata });
      }
      if (Buffer.byteLength(document, "utf8") > this.maxSkillBytes) fail("skill_too_large", "Skill document exceeds the configured size limit");

      await mkdir(target);
      try {
        await atomicWrite(join(target, SKILL_FILE), document);
      } catch (error) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const canonicalTarget = await realpath(target);
      const skill = (await this.#discover()).find((candidate) => candidate._skillDirectory === canonicalTarget);
      if (!skill) fail("invalid_skill_document", "Created skill could not be discovered");
      return publicSkill(skill, true);
    });
  }

  async delete(id) {
    return this.#queueMutation(async () => {
      if (typeof id !== "string" || !PUBLIC_ID_RE.test(id)) fail("skill_not_found", "Skill not found");
      const skill = (await this.#discover()).find((candidate) => candidate.id === id);
      if (!skill) fail("skill_not_found", "Skill not found");
      if (!skill.owned) fail("root_not_owned", "Skills in custom roots are read-only");
      if (skill.provenance === "workspace") {
        const currentRoot = await this.#workspaceRootDescriptor();
        if (!currentRoot.owned || !currentRoot.canonical ||
          pathKey(currentRoot.canonical) !== pathKey(skill._rootCanonical)) {
          fail("root_not_owned", "Workspace skills root is no longer owned by the workspace");
        }
      }

      const directory = await secureDirectory(skill._skillDirectory);
      if (!directory || !isPathInside(skill._rootCanonical, directory, true)) fail("path_escape", "Skill path is no longer safe");
      if (skill._atRoot) {
        const fileInfo = await pathInfoNoSymlink(skill._skillFile);
        if (!fileInfo?.isFile()) fail("skill_not_found", "Skill not found");
        await unlink(skill._skillFile);
      } else {
        if (!isPathInside(skill._rootCanonical, directory, false)) fail("path_escape", "Refusing to delete a skills root");
        await rm(directory, { recursive: true, force: false });
      }
      this.state.disabledIds = this.state.disabledIds.filter((candidate) => candidate !== id);
      delete this.state.usage[id];
      return { ok: true, id };
    });
  }

  async addRoot(path) {
    return this.#queueMutation(async () => {
      if (typeof path !== "string" || !path.trim() || !isAbsolute(path) || path.includes("\0")) {
        fail("invalid_root", "Custom skills roots must be absolute paths");
      }
      const canonical = await secureDirectory(path);
      if (!canonical) fail("invalid_root", "Custom skills root must be an existing non-symlink directory");
      const roots = await this.rootsInternal();
      for (const root of roots) {
        const existing = root.canonical ?? root.path;
        if (pathsOverlap(existing, canonical)) {
          if (pathKey(existing) === pathKey(canonical) && root.provenance === "custom") return publicRoot(root);
          fail("root_overlap", "Custom skills roots cannot overlap another configured root");
        }
      }
      this.state.customRoots.push(canonical);
      return publicRoot(await this.#rootDescriptor(canonical, "custom", false));
    });
  }

  async removeRoot(idOrPath) {
    return this.#queueMutation(async () => {
      if (typeof idOrPath !== "string" || !idOrPath.trim()) fail("root_not_found", "Skills root not found");
      const roots = await this.rootsInternal();
      const requestedPath = isAbsolute(idOrPath) ? pathKey(idOrPath) : null;
      const root = roots.find((candidate) => candidate.provenance === "custom" &&
        (candidate.id === idOrPath || (requestedPath && pathKey(candidate.path) === requestedPath)));
      if (!root) fail("root_not_found", "Custom skills root not found");
      this.state.customRoots = this.state.customRoots.filter((path) => pathKey(path) !== pathKey(root.path));
      return { ok: true, id: root.id };
    });
  }

  async setEnabled(id, enabled) {
    return this.#queueMutation(async () => {
      if (typeof id !== "string" || !PUBLIC_ID_RE.test(id)) fail("skill_not_found", "Skill not found");
      const skill = (await this.#discover()).find((candidate) => candidate.id === id);
      if (!skill) fail("skill_not_found", "Skill not found");
      const disabled = new Set(this.state.disabledIds);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      this.state.disabledIds = [...disabled].sort();
      return { ...publicSkill(skill), enabled: Boolean(enabled) };
    });
  }

  async recordUsage(id, delta = 1) {
    return this.#queueMutation(async () => {
      if (typeof id !== "string" || !PUBLIC_ID_RE.test(id)) fail("skill_not_found", "Skill not found");
      if (!Number.isSafeInteger(delta) || delta <= 0 || delta > 1_000_000) fail("invalid_usage_delta", "Usage delta must be a positive safe integer");
      const skill = (await this.#discover()).find((candidate) => candidate.id === id);
      if (!skill) fail("skill_not_found", "Skill not found");
      const previous = normalizeUsage(this.state.usage[id]) ?? { total: 0 };
      const total = Math.min(Number.MAX_SAFE_INTEGER, previous.total + delta);
      const lastUsedAt = new Date().toISOString();
      this.state.usage[id] = { total, lastUsedAt };
      return { id, usage: total, lastUsedAt };
    });
  }

  async runtimeSkills({ ids, maxSkills = 32, maxChars = 64_000 } = {}) {
    await this.#settled();
    const skillLimit = Math.max(0, Math.min(HARD_MAX_RUNTIME_SKILLS, Number.isFinite(maxSkills) ? Math.floor(maxSkills) : 32));
    const charLimit = Math.max(0, Math.min(HARD_MAX_RUNTIME_CHARS, Number.isFinite(maxChars) ? Math.floor(maxChars) : 64_000));
    const requested = Array.isArray(ids) ? new Set(ids.filter((id) => typeof id === "string" && PUBLIC_ID_RE.test(id))) : null;
    const discovered = (await this.#discover()).filter((skill) => skill.enabled && (!requested || requested.has(skill.id)));

    // A workspace skill intentionally shadows an equally named global/custom
    // skill for runtime injection, while list() still exposes every source.
    const uniqueByName = new Map();
    for (const skill of discovered) {
      const key = skill.name.toLowerCase();
      if (!uniqueByName.has(key)) uniqueByName.set(key, skill);
    }
    const candidates = [...uniqueByName.values()].sort((left, right) =>
      right.usage - left.usage || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

    const included = [];
    const chunks = [];
    let chars = 0;
    for (const skill of candidates) {
      if (included.length >= skillLimit) break;
      const chunk = `<<skill:${skill.name} id=${skill.id} provenance=${skill.provenance}>>\n${skill.content.trim()}\n<</skill>>`;
      const separator = chunks.length ? "\n\n" : "";
      if (chars + separator.length + chunk.length > charLimit) continue;
      chunks.push(chunk);
      chars += separator.length + chunk.length;
      included.push(publicSkill(skill, true));
    }
    return {
      skills: included,
      text: chunks.join("\n\n"),
      total: candidates.length,
      included: included.length,
      chars,
      truncated: included.length < candidates.length,
    };
  }
}
