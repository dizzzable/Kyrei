/**
 * Cross-process advisory file lock (O_EXCL). One writer per structural file.
 * Requirements §6.3 (single-writer), §5.3 of blueprint.
 */

import { open, rm, readFile, stat } from "node:fs/promises";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const s = await stat(lockPath);
    if (Date.now() - s.mtimeMs > staleMs) return true;
    const info = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
    // If the owning pid is gone, the lock is stale.
    if (info.pid && info.pid !== process.pid) {
      try {
        process.kill(info.pid, 0);
        return false;
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lock = target + ".lock";
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const staleMs = opts.staleMs ?? 30_000;
  for (;;) {
    try {
      const fh = await open(lock, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await isStale(lock, staleMs)) {
        await rm(lock, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${target}`);
      await sleep(50 + Math.random() * 50);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true }).catch(() => {});
  }
}
