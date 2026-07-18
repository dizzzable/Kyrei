/** Safe project-document ingestion. Files remain the source of truth. */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export const DOCUMENT_IMPORT_MAX_FILES = 24;
export const DOCUMENT_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_IMPORT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".json", ".jsonl",
  ".yaml", ".yml", ".toml", ".csv", ".tsv",
]);

export interface ProjectDocumentInput {
  fileName: string;
  /** Optional root-relative path supplied by a folder import. */
  relativePath?: string;
  bytes: Uint8Array;
}

export interface ImportedProjectDocument {
  fileName: string;
  path: string;
  relativePath: string;
  contentHash: string;
  bytes: number;
  deduped: boolean;
}

export interface RejectedProjectDocument {
  fileName: string;
  code: "document_type_unsupported" | "document_too_large" | "document_binary_unsupported" | "document_invalid_name" | "document_path_invalid";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(raw: string): string {
  const leaf = String(raw ?? "").split(/[\\/]/).at(-1)?.trim() ?? "";
  if (!leaf || leaf === "." || leaf === ".." || leaf.includes("\0")) return "";
  const normalized = leaf
    .normalize("NFKC")
    .replace(/[<>:"|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 140)
    .trim();
  return normalized;
}

function safeRelativeDirectory(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  const value = String(raw).replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.includes("\0")) return null;
  const segments = value.split("/");
  if (segments.length > 32 || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const folders = segments.slice(0, -1).map(safeName);
  return folders.some((segment) => !segment) ? null : folders;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const controls = [...text.slice(0, 8_000)].filter((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;
    return controls > 8 ? null : text;
  } catch {
    return null;
  }
}

export async function importProjectDocuments(input: {
  workspace: string;
  files: readonly ProjectDocumentInput[];
}): Promise<{ imported: ImportedProjectDocument[]; rejected: RejectedProjectDocument[] }> {
  const workspace = resolve(input.workspace);
  const files = input.files.slice(0, DOCUMENT_IMPORT_MAX_FILES);
  const imported: ImportedProjectDocument[] = [];
  const rejected: RejectedProjectDocument[] = [];
  let total = 0;
  const destination = join(workspace, ".kyrei", "memory", "imports");
  await mkdir(destination, { recursive: true });

  for (const file of files) {
    const fileName = safeName(file.fileName);
    if (!fileName) {
      rejected.push({ fileName: String(file.fileName ?? ""), code: "document_invalid_name" });
      continue;
    }
    const relativeDirectory = safeRelativeDirectory(file.relativePath);
    if (!relativeDirectory) {
      rejected.push({ fileName, code: "document_path_invalid" });
      continue;
    }
    const extension = extname(fileName).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      rejected.push({ fileName, code: "document_type_unsupported" });
      continue;
    }
    if (file.bytes.byteLength > DOCUMENT_IMPORT_MAX_FILE_BYTES
      || total + file.bytes.byteLength > DOCUMENT_IMPORT_MAX_TOTAL_BYTES) {
      rejected.push({ fileName, code: "document_too_large" });
      continue;
    }
    total += file.bytes.byteLength;
    const text = decodeText(file.bytes);
    if (text === null) {
      rejected.push({ fileName, code: "document_binary_unsupported" });
      continue;
    }
    const digest = sha256(file.bytes);
    const stem = fileName.slice(0, Math.max(1, fileName.length - extension.length));
    const storedName = `${stem}-${digest.slice(0, 10)}${extension}`;
    const documentDirectory = join(destination, ...relativeDirectory);
    await mkdir(documentDirectory, { recursive: true });
    const path = join(documentDirectory, storedName);
    let deduped = false;
    try {
      const current = await readFile(path);
      deduped = sha256(current) === digest;
    } catch {
      /* new document */
    }
    if (!deduped) {
      const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
      try {
        await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    imported.push({
      fileName,
      path,
      relativePath: [".kyrei", "memory", "imports", ...relativeDirectory, storedName].join("/"),
      contentHash: digest,
      bytes: file.bytes.byteLength,
      deduped,
    });
  }

  return { imported, rejected };
}
