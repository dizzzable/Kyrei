/**
 * Wave D4/E1 — budgeted symbol repo map (Aider-style, training-free).
 * Regex outline of exports/signatures for navigation context — not a parser AST.
 * Complements import-graph project-index without embedding/RAG.
 * Wave E: process-local mtime cache to avoid rescanning every turn.
 */

import fg from "fast-glob";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_GLOB = [
  "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs}",
];
const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.kyrei/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/vendor/**",
  "hermes/**",
  "**/linux-unpacked/**",
  "**/win-unpacked/**",
];

const SIG = /^(export\s+)?(async\s+)?(function|class|const|let|type|interface|enum|def|fn|pub\s+(fn|struct|enum|trait)|struct|impl|public\s+class)\b/;

export interface SymbolMapOptions {
  maxChars?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
}

function scorePath(path: string): number {
  let s = 0;
  if (/(^|\/)(src|lib|core|app|packages)\//.test(path)) s += 4;
  if (/(index|main|app|gateway|engine|orchestr)/i.test(path)) s += 3;
  if (/\.test\.|\.spec\.|__tests__|\/tests?\//i.test(path)) s -= 3;
  if (path.split("/").length <= 3) s += 1;
  return s;
}

function symbolsFromSource(source: string, limit: number): string[] {
  const out: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trim = line.trim();
    if (!SIG.test(trim) && !/^export\s+\{/.test(trim)) continue;
    out.push(`L${i + 1} ${trim.slice(0, 100)}`);
    if (out.length >= limit) break;
  }
  return out;
}

interface SymbolMapCacheEntry {
  fingerprint: string;
  maxChars: number;
  text: string;
  builtAt: number;
  fromCache?: boolean;
}

const symbolMapCache = new Map<string, SymbolMapCacheEntry>();
/** Soft TTL: rescans at least every 60s even if fingerprint matches. */
const SYMBOL_MAP_TTL_MS = 60_000;

/** Test helper / full flush. */
export function clearSymbolMapCache(): void {
  symbolMapCache.clear();
}

/** Wave F: drop cache for one workspace after successful file mutations. */
export function invalidateSymbolMapCache(workspace: string): void {
  symbolMapCache.delete(workspace.replaceAll("\\", "/"));
}

async function workspaceFingerprint(workspace: string): Promise<string> {
  const markers = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml"];
  const parts: string[] = [];
  for (const name of markers) {
    try {
      const s = await stat(join(workspace, name));
      parts.push(`${name}:${s.mtimeMs}:${s.size}`);
    } catch {
      /* missing marker */
    }
  }
  try {
    const s = await stat(workspace);
    parts.push(`root:${s.mtimeMs}`);
  } catch {
    /* */
  }
  return parts.join("|") || "empty";
}

/**
 * Build a compact multi-file symbol outline for system context.
 * Fail-open: returns empty string on any IO/scan error.
 * Wave E: process-local cache keyed by marker file mtimes + TTL.
 */
export async function buildBudgetedSymbolMap(
  workspace: string,
  options: SymbolMapOptions = {},
): Promise<string> {
  const maxChars = Math.max(400, options.maxChars ?? 1_600);
  const maxFiles = Math.max(8, Math.min(80, options.maxFiles ?? 36));
  const maxBytes = Math.max(4_000, options.maxBytesPerFile ?? 80_000);
  const cacheKey = workspace.replaceAll("\\", "/");

  const fingerprint = await workspaceFingerprint(workspace);
  const hit = symbolMapCache.get(cacheKey);
  if (
    hit
    && hit.maxChars === maxChars
    && hit.fingerprint === fingerprint
    && Date.now() - hit.builtAt < SYMBOL_MAP_TTL_MS
  ) {
    hit.fromCache = true;
    return hit.text;
  }

  let files: string[];
  try {
    files = await fg(SOURCE_GLOB, {
      cwd: workspace,
      onlyFiles: true,
      absolute: false,
      dot: false,
      followSymbolicLinks: false,
      ignore: IGNORE,
      suppressErrors: true,
    });
  } catch {
    return "";
  }

  files = files
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => !p.includes("node_modules"))
    .sort((a, b) => scorePath(b) - scorePath(a) || a.localeCompare(b))
    .slice(0, maxFiles * 2);

  const blocks: string[] = [];
  let used = 0;
  let filesUsed = 0;

  for (const rel of files) {
    if (filesUsed >= maxFiles || used >= maxChars - 80) break;
    try {
      const raw = await readFile(join(workspace, rel), "utf8");
      if (raw.length > maxBytes) continue;
      const syms = symbolsFromSource(raw, 8);
      if (!syms.length) continue;
      const block = `${rel}\n  ${syms.join("\n  ")}`;
      if (used + block.length + 1 > maxChars) continue;
      blocks.push(block);
      used += block.length + 1;
      filesUsed += 1;
    } catch {
      /* skip unreadable */
    }
  }

  if (!blocks.length) {
    symbolMapCache.set(cacheKey, { fingerprint, maxChars, text: "", builtAt: Date.now(), fromCache: false });
    return "";
  }
  const text = [
    "Repo symbol map (budgeted outlines — verify with read_file/grep before editing):",
    ...blocks,
  ].join("\n");
  symbolMapCache.set(cacheKey, { fingerprint, maxChars, text, builtAt: Date.now(), fromCache: false });
  return text;
}

/** Whether the last lookup for workspace returned a warm cache entry. */
export function symbolMapLastWasCacheHit(workspace: string): boolean {
  return Boolean(symbolMapCache.get(workspace.replaceAll("\\", "/"))?.fromCache);
}
