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
import { embedText } from "./embed-adapter.js";

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

      await rm(join(vaultDir, "alpha.md"));
      const rebuilt = await indexVaultIntoMemory({
        vault: {
          enabled: true,
          paths: [vaultDir],
          maxFiles: 50,
          maxFileChars: 4_000,
          maxDepth: 4,
        },
        memory: opened.stores!.memory,
        vectors: opened.stores!.vectors,
        workspaceTag: root,
      });
      expect(rebuilt.files).toBe(2);
      expect(rebuilt.pruned).toBe(1);
      const afterDelete = await opened.stores!.memory.listDocs({ scope: "project", workspace: root });
      expect(afterDelete.some((d) => d.path.endsWith("alpha.md"))).toBe(false);

      const disabled = await indexVaultIntoMemory({
        vault: {
          enabled: false,
          paths: [],
          maxFiles: 50,
          maxFileChars: 4_000,
          maxDepth: 4,
        },
        memory: opened.stores!.memory,
        vectors: opened.stores!.vectors,
        workspaceTag: root,
      });
      expect(disabled.files).toBe(0);
      expect(disabled.pruned).toBe(2);
      const afterDisable = await opened.stores!.memory.listDocs({ scope: "project", workspace: root });
      expect(afterDisable.filter((d) => d.sourceRef === "vault:markdown")).toHaveLength(0);
      const vectorHits = await opened.stores!.vectors!.query(await embedText("widgets"), {
        k: 20,
        ownerType: "memory_doc",
      });
      expect(vectorHits.some((hit) => hit.ownerId.startsWith("vault:"))).toBe(false);
    } finally {
      await closeMemoryIndex(opened.stores);
    }
  });
});
