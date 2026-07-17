/**
 * Wave C3 — external markdown vault index (Tolaria-adjacent).
 *
 * Optional user-configured absolute directories of markdown notes.
 * Indexed into the same rebuildable memory projection as Tier A — files remain
 * SoT; vault is never system policy. Caps prevent runaway scans.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep, extname, basename } from "node:path";
import type { MemoryDoc, MemoryStore, VectorStore } from "../data/ports.js";
import { embedText, getEmbedAdapter, isZeroVector } from "./embed-adapter.js";

export interface VaultConfig {
  enabled: boolean;
  /** Absolute directories the user opted in (external knowledge bases). */
  paths: string[];
  maxFiles: number;
  maxFileChars: number;
  maxDepth: number;
}

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  enabled: false,
  paths: [],
  maxFiles: 200,
  maxFileChars: 12_000,
  maxDepth: 6,
};

export function normalizeVaultConfig(value: unknown): VaultConfig {
  const src = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const rawPaths = Array.isArray(src.paths) ? src.paths : [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const p of rawPaths) {
    if (typeof p !== "string" || !p.trim() || p.includes("\0")) continue;
    const abs = resolve(p.trim());
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(abs);
    if (paths.length >= 8) break;
  }
  return {
    enabled: src.enabled === true,
    paths,
    maxFiles: Number.isFinite(Number(src.maxFiles))
      ? Math.max(10, Math.min(2_000, Math.floor(Number(src.maxFiles))))
      : DEFAULT_VAULT_CONFIG.maxFiles,
    maxFileChars: Number.isFinite(Number(src.maxFileChars))
      ? Math.max(1_000, Math.min(100_000, Math.floor(Number(src.maxFileChars))))
      : DEFAULT_VAULT_CONFIG.maxFileChars,
    maxDepth: Number.isFinite(Number(src.maxDepth))
      ? Math.max(1, Math.min(12, Math.floor(Number(src.maxDepth))))
      : DEFAULT_VAULT_CONFIG.maxDepth,
  };
}

function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 24);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (!rel) return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("..\\");
}

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".kyrei",
  "dist",
  "build",
  ".cache",
  "vendor",
]);

async function walkMarkdown(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  out: string[],
  maxFiles: number,
): Promise<void> {
  if (out.length >= maxFiles || depth > maxDepth) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true }) as typeof entries;
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const name = String(entry.name);
    if (name.startsWith(".") && name !== ".md") continue;
    const full = join(dir, name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(name.toLowerCase())) continue;
      await walkMarkdown(root, full, depth + 1, maxDepth, out, maxFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(name).toLowerCase();
    if (ext !== ".md" && ext !== ".mdx" && ext !== ".markdown") continue;
    if (!isInside(root, full)) continue;
    out.push(full);
  }
}

export interface VaultFile {
  root: string;
  path: string;
  relativePath: string;
  title: string;
  body: string;
}

/**
 * Scan configured vault roots for markdown (fail-open per root).
 */
export async function scanVaultFiles(config: VaultConfig): Promise<VaultFile[]> {
  const cfg = normalizeVaultConfig(config);
  if (!cfg.enabled || !cfg.paths.length) return [];
  const files: VaultFile[] = [];
  for (const rootPath of cfg.paths) {
    if (files.length >= cfg.maxFiles) break;
    let rootReal: string;
    try {
      const st = await stat(rootPath);
      if (!st.isDirectory()) continue;
      rootReal = await realpath(rootPath);
    } catch {
      continue;
    }
    const found: string[] = [];
    await walkMarkdown(rootReal, rootReal, 0, cfg.maxDepth, found, cfg.maxFiles - files.length);
    for (const abs of found) {
      try {
        const bodyRaw = await readFile(abs, "utf8");
        const body = bodyRaw.slice(0, cfg.maxFileChars);
        if (!body.trim()) continue;
        const rel = relative(rootReal, abs).replaceAll("\\", "/");
        const title = basename(abs, extname(abs));
        files.push({
          root: rootReal,
          path: abs,
          relativePath: rel,
          title,
          body,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return files;
}

export interface IndexVaultOptions {
  vault: VaultConfig;
  memory: MemoryStore;
  vectors?: VectorStore;
  /** Workspace id tag for MemoryDoc.workspace (vault is external). */
  workspaceTag?: string;
}

/**
 * Project vault markdown into MemoryStore (rebuildable; files remain SoT).
 */
export async function indexVaultIntoMemory(opts: IndexVaultOptions): Promise<{
  upserted: number;
  vectorsUpserted: number;
  files: number;
}> {
  const cfg = normalizeVaultConfig(opts.vault);
  if (!cfg.enabled) return { upserted: 0, vectorsUpserted: 0, files: 0 };
  const files = await scanVaultFiles(cfg);
  let upserted = 0;
  let vectorsUpserted = 0;
  const workspace = opts.workspaceTag || "vault";
  const pendingVectors: Array<{
    ownerType: string;
    ownerId: string;
    chunkIndex: number;
    model: string;
    embedding: Float32Array;
    contentHash: string;
  }> = [];

  for (const f of files) {
    const id = `vault:${contentHash(f.root)}:${f.relativePath}`;
    const doc: MemoryDoc = {
      id,
      scope: "project",
      kind: "memory",
      path: f.path,
      workspace,
      title: `vault:${f.title}`,
      body: f.body,
      sourceRef: "vault:markdown",
      contentHash: contentHash(f.body),
      updatedAt: new Date().toISOString(),
      frontmatter: { vaultRoot: f.root, relativePath: f.relativePath },
    };
    await opts.memory.upsertDoc(doc);
    upserted += 1;
    if (opts.vectors) {
      try {
        const embedding = await embedText(`${doc.title}\n${doc.body}`);
        if (!isZeroVector(embedding)) {
          pendingVectors.push({
            ownerType: "memory_doc",
            ownerId: doc.id,
            chunkIndex: 0,
            model: getEmbedAdapter().modelId,
            embedding,
            contentHash: doc.contentHash,
          });
        }
      } catch {
        /* fail-open */
      }
    }
  }
  if (opts.vectors && pendingVectors.length) {
    try {
      await opts.vectors.upsert(pendingVectors);
      vectorsUpserted = pendingVectors.length;
    } catch {
      vectorsUpserted = 0;
    }
  }
  return { upserted, vectorsUpserted, files: files.length };
}

/** Lightweight lexical search over vault files (no index required). */
export async function searchVaultFiles(
  config: VaultConfig,
  query: string,
  limit = 8,
): Promise<Array<{ title: string; path: string; snippet: string; score: number }>> {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const files = await scanVaultFiles(config);
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const hits: Array<{ title: string; path: string; snippet: string; score: number }> = [];
  for (const f of files) {
    const hay = `${f.title}\n${f.body}`.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 8;
    for (const t of tokens) {
      if (hay.includes(t)) score += 2;
    }
    if (score <= 0) continue;
    const idx = hay.indexOf(tokens[0] || q);
    const start = Math.max(0, idx - 40);
    const snippet = f.body.slice(start, start + 220).replace(/\s+/g, " ").trim();
    hits.push({ title: f.title, path: f.relativePath, snippet, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, Math.min(20, limit)));
}
