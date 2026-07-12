/**
 * Reversible snapshots (Phase 2: copy-based, works in non-git workspaces).
 * Git-based snapshots are an optional optimization for later.
 * Requirements §3.7, Property 3.
 */

import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

export interface SnapshotStore {
  create(relPaths: string[]): Promise<string>;
  restore(id: string): Promise<void>;
  gc(): Promise<{ removed: number }>;
}

interface ManifestEntry {
  rel: string;
  existed: boolean;
}
interface Manifest {
  id: string;
  ts: number;
  files: ManifestEntry[];
}

export interface SnapshotOptions {
  maxCount?: number;
  maxAgeDays?: number;
}

export function createSnapshotStore(workspace: string, opts: SnapshotOptions = {}): SnapshotStore {
  const dir = join(workspace, ".kyrei", "snapshots");
  const maxCount = opts.maxCount ?? 50;
  const maxAgeMs = (opts.maxAgeDays ?? 7) * 86_400_000;

  async function create(relPaths: string[]): Promise<string> {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const snapDir = join(dir, id);
    const files: ManifestEntry[] = [];
    for (const rel of relPaths) {
      const src = resolve(workspace, rel);
      try {
        const bytes = await readFile(src);
        const dest = join(snapDir, "files", rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        files.push({ rel, existed: true });
      } catch {
        files.push({ rel, existed: false });
      }
    }
    const manifest: Manifest = { id, ts: Date.now(), files };
    await mkdir(snapDir, { recursive: true });
    await writeFile(join(snapDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    void gc();
    return id;
  }

  async function restore(id: string): Promise<void> {
    const snapDir = join(dir, id);
    const manifest = JSON.parse(await readFile(join(snapDir, "manifest.json"), "utf8")) as Manifest;
    for (const f of manifest.files) {
      const target = resolve(workspace, f.rel);
      if (f.existed) {
        const bytes = await readFile(join(snapDir, "files", f.rel));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      } else {
        await rm(target, { force: true });
      }
    }
  }

  async function gc(): Promise<{ removed: number }> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return { removed: 0 };
    }
    const withTs: Array<{ id: string; ts: number }> = [];
    for (const id of entries) {
      try {
        const s = await stat(join(dir, id));
        withTs.push({ id, ts: s.mtimeMs });
      } catch {
        /* skip */
      }
    }
    withTs.sort((a, b) => b.ts - a.ts);
    const now = Date.now();
    let removed = 0;
    for (let i = 0; i < withTs.length; i++) {
      const e = withTs[i]!;
      const tooOld = now - e.ts > maxAgeMs;
      const tooMany = i >= maxCount;
      if (tooOld || tooMany) {
        await rm(join(dir, e.id), { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
    return { removed };
  }

  return { create, restore, gc };
}
