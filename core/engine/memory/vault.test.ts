import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeVaultConfig,
  scanVaultFiles,
  searchVaultFiles,
  indexVaultIntoMemory,
} from "./vault.js";
import { openMemoryIndex, closeMemoryIndex } from "./index-backend.js";

describe("vault (Wave C3)", () => {
  let root: string;
  let vaultDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kyrei-vault-"));
    vaultDir = join(root, "notes");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "alpha.md"), "# Alpha\n\nSecret vault fact about widgets.\n", "utf8");
    await writeFile(join(vaultDir, "beta.md"), "# Beta\n\nAnother note on gadgets.\n", "utf8");
    await mkdir(join(vaultDir, "nested"), { recursive: true });
    await writeFile(join(vaultDir, "nested", "gamma.md"), "Nested gamma content\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("normalizes paths and caps", () => {
    const cfg = normalizeVaultConfig({
      enabled: true,
      paths: [vaultDir, vaultDir, "relative-nope"],
      maxFiles: 9_999,
    });
    // relative paths still resolve to absolute
    expect(cfg.paths.length).toBeGreaterThanOrEqual(1);
    expect(cfg.maxFiles).toBe(2_000);
    expect(cfg.enabled).toBe(true);
  });

  it("scans markdown files under vault roots", async () => {
    const files = await scanVaultFiles({
      enabled: true,
      paths: [vaultDir],
      maxFiles: 50,
      maxFileChars: 4_000,
      maxDepth: 4,
    });
    expect(files.length).toBe(3);
    expect(files.some((f) => f.title === "alpha")).toBe(true);
    expect(files.some((f) => f.relativePath.includes("nested"))).toBe(true);
  });

  it("searches vault lexically", async () => {
    const hits = await searchVaultFiles(
      {
        enabled: true,
        paths: [vaultDir],
        maxFiles: 50,
        maxFileChars: 4_000,
        maxDepth: 4,
      },
      "widgets",
      5,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe("alpha");
  });

  it("indexes vault into memory store", async () => {
    const opened = await openMemoryIndex(root, { enabled: true, backend: "sqlite" });
    expect(opened.stores?.memory).toBeTruthy();
    try {
      const result = await indexVaultIntoMemory({
        vault: {
          enabled: true,
          paths: [vaultDir],
          maxFiles: 50,
          maxFileChars: 4_000,
          maxDepth: 4,
        },
        memory: opened.stores!.memory,
        workspaceTag: root,
      });
      expect(result.files).toBe(3);
      expect(result.upserted).toBe(3);
      const found = await opened.stores!.memory.search("widgets", { limit: 5 });
      expect(found.some((d) => d.body.includes("widgets"))).toBe(true);
    } finally {
      await closeMemoryIndex(opened.stores);
    }
  });
});
