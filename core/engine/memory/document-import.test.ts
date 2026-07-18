import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importProjectDocuments } from "./document-import.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("importProjectDocuments", () => {
  it("stores supported text documentation under the workspace memory SoT", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-doc-import-"));
    roots.push(workspace);

    const result = await importProjectDocuments({
      workspace,
      files: [{
        fileName: "../Architecture Notes.md",
        bytes: new TextEncoder().encode("# Architecture\n\nQueues use bounded retries."),
      }],
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.relativePath).toMatch(/^\.kyrei\/memory\/imports\//);
    expect(result.imported[0]?.relativePath).not.toContain("..");
    expect(await readFile(result.imported[0]!.path, "utf8")).toContain("bounded retries");
  });

  it("deduplicates identical content and rejects binary/unsupported files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-doc-import-"));
    roots.push(workspace);
    const file = { fileName: "guide.txt", bytes: new TextEncoder().encode("stable guide") };

    const first = await importProjectDocuments({ workspace, files: [file] });
    const second = await importProjectDocuments({ workspace, files: [file] });
    const rejected = await importProjectDocuments({
      workspace,
      files: [
        { fileName: "payload.exe", bytes: new Uint8Array([1, 2, 3]) },
        { fileName: "binary.txt", bytes: new Uint8Array([0, 1, 2]) },
      ],
    });

    expect(first.imported[0]?.deduped).toBe(false);
    expect(second.imported[0]?.deduped).toBe(true);
    expect(rejected.rejected.map((item) => item.code)).toEqual([
      "document_type_unsupported",
      "document_binary_unsupported",
    ]);
  });

  it("preserves an explicit folder-relative path and rejects traversal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-doc-import-tree-"));
    roots.push(workspace);

    const result = await importProjectDocuments({
      workspace,
      files: [{
        fileName: "guide.md",
        relativePath: "Product/Architecture/guide.md",
        bytes: new TextEncoder().encode("# Nested guide"),
      }, {
        fileName: "secret.md",
        relativePath: "Product/../secret.md",
        bytes: new TextEncoder().encode("must not import"),
      }],
    });

    expect(result.imported[0]?.relativePath).toMatch(/^\.kyrei\/memory\/imports\/Product\/Architecture\/guide-[a-f0-9]{10}\.md$/);
    expect(await readFile(result.imported[0]!.path, "utf8")).toContain("Nested guide");
    expect(result.rejected).toContainEqual({ fileName: "secret.md", code: "document_path_invalid" });
  });
});
