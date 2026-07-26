import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_CONTEXT_SUMMARIES,
  ORPHAN_TMP_MS,
  clearContextSummary,
  contextSummariesToDrop,
  contextSummaryDir,
  pruneContextSummaries,
  readContextSummary,
  writeContextSummary,
} from "./summary-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "kyrei-summary-store-"));
  roots.push(root);
  return root;
}

function record(sessionId: string) {
  return {
    sessionId,
    updatedAt: new Date().toISOString(),
    via: "heuristic" as const,
    summaryText: `summary for ${sessionId}`,
    sourceMessageCount: 3,
    charCount: 20,
  };
}

describe("contextSummariesToDrop", () => {
  const entry = (name: string, mtimeMs: number) => ({ name, mtimeMs });

  it("keeps nothing to drop when the directory is under the cap", () => {
    expect(contextSummariesToDrop([entry("a.json", 3), entry("b.json", 1)], { keep: 5 })).toEqual([]);
  });

  it("drops the least recently written first", () => {
    const entries = [entry("old.json", 1), entry("mid.json", 2), entry("new.json", 3)];
    expect(contextSummariesToDrop(entries, { keep: 2 })).toEqual(["old.json"]);
    expect(contextSummariesToDrop(entries, { keep: 1 })).toEqual(["mid.json", "old.json"]);
  });

  it("never drops the file the caller just wrote", () => {
    // Its mtime may not be the newest yet on a coarse-resolution filesystem, so
    // recency alone is not enough to protect it.
    const entries = [entry("fresh.json", 0), entry("other.json", 9), entry("another.json", 8)];
    expect(contextSummariesToDrop(entries, { keep: 1, protect: "fresh.json" })).toEqual([
      "other.json",
      "another.json",
    ]);
  });

  it("treats a keep of zero as one, so a sweep can never empty the directory", () => {
    expect(contextSummariesToDrop([entry("a.json", 2), entry("b.json", 1)], { keep: 0 })).toEqual(["b.json"]);
  });

  it("orders deterministically when timestamps tie", () => {
    const entries = [entry("b.json", 5), entry("a.json", 5), entry("c.json", 5)];
    expect(contextSummariesToDrop(entries, { keep: 1 })).toEqual(["b.json", "c.json"]);
  });
});

describe("pruneContextSummaries", () => {
  it("does nothing when the directory does not exist", async () => {
    await expect(pruneContextSummaries(await workspace())).resolves.toBeUndefined();
  });

  it("caps the directory and keeps the newest", async () => {
    const root = await workspace();
    const dir = contextSummaryDir(root);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const file = join(dir, `s${i}.json`);
      await writeFile(file, "{}", "utf8");
      // Explicit mtimes: writes inside one millisecond would otherwise tie.
      await utimes(file, new Date(1_000 + i), new Date(1_000 + i));
    }

    await pruneContextSummaries(root, { keep: 2 });

    expect((await readdir(dir)).sort()).toEqual(["s3.json", "s4.json"]);
  });

  it("removes an orphaned temp file but spares one that may still be in flight", async () => {
    // A crash between writeFile and rename leaves a .tmp behind forever.
    const root = await workspace();
    const dir = contextSummaryDir(root);
    await mkdir(dir, { recursive: true });
    const stale = join(dir, "s.json.123-abc.tmp");
    const fresh = join(dir, "s.json.456-def.tmp");
    await writeFile(stale, "partial", "utf8");
    await writeFile(fresh, "partial", "utf8");
    const now = Date.now();
    await utimes(stale, new Date(now - ORPHAN_TMP_MS - 60_000), new Date(now - ORPHAN_TMP_MS - 60_000));

    await pruneContextSummaries(root, { now });

    const left = await readdir(dir);
    expect(left).not.toContain("s.json.123-abc.tmp");
    expect(left).toContain("s.json.456-def.tmp");
  });
});

describe("writeContextSummary", () => {
  it("round-trips a record and leaves no temp file behind", async () => {
    const root = await workspace();
    await writeContextSummary(root, record("alpha"));

    expect((await readContextSummary(root, "alpha"))?.summaryText).toBe("summary for alpha");
    expect((await readdir(contextSummaryDir(root))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("bounds the directory as a side effect of writing", async () => {
    const root = await workspace();
    const dir = contextSummaryDir(root);
    await mkdir(dir, { recursive: true });
    // Pre-existing summaries beyond the cap, all older than the one to come.
    for (let i = 0; i < MAX_CONTEXT_SUMMARIES + 5; i += 1) {
      const file = join(dir, `old-${i}.json`);
      await writeFile(file, "{}", "utf8");
      await utimes(file, new Date(1_000 + i), new Date(1_000 + i));
    }

    await writeContextSummary(root, record("newest"));

    const left = await readdir(dir);
    expect(left).toHaveLength(MAX_CONTEXT_SUMMARIES);
    // The just-written record survives and is still readable.
    expect(left).toContain("newest.json");
    expect((await readContextSummary(root, "newest"))?.summaryText).toBe("summary for newest");
  });
});

describe("clearContextSummary", () => {
  it("removes one session's summary and tolerates a missing file", async () => {
    const root = await workspace();
    await writeContextSummary(root, record("gone"));
    await writeContextSummary(root, record("kept"));

    await clearContextSummary(root, "gone");
    await expect(clearContextSummary(root, "never-existed")).resolves.toBeUndefined();

    expect(await readContextSummary(root, "gone")).toBeNull();
    expect(await readContextSummary(root, "kept")).not.toBeNull();
    await expect(stat(join(contextSummaryDir(root), "kept.json"))).resolves.toBeTruthy();
  });
});
