/**
 * File encoding/EOL/BOM detection and byte serialization.
 * Requirements §3.8 (preserve EOL/final newline), §3.9 (preserve BOM), §3.13 (binary refuse).
 */

export interface FileMeta {
  bom: "utf8" | "utf16le" | "utf16be" | null;
  eol: "lf" | "crlf" | "mixed";
  eolDominant: "\n" | "\r\n";
  finalNewline: boolean;
  encoding: "utf8" | "binary";
}

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

export function isBinary(body: Buffer): boolean {
  const n = Math.min(body.length, 8192);
  if (n === 0) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = body[i]!;
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, n));
  } catch {
    return true;
  }
  return ctrl / n > 0.3;
}

export function detectMeta(buf: Buffer): FileMeta {
  let bom: FileMeta["bom"] = null;
  let body = buf;
  if (buf.subarray(0, 3).equals(BOM_UTF8)) {
    bom = "utf8";
    body = buf.subarray(3);
  } else if (buf.subarray(0, 2).equals(BOM_UTF16LE)) {
    bom = "utf16le";
    body = buf.subarray(2);
  } else if (buf.subarray(0, 2).equals(BOM_UTF16BE)) {
    bom = "utf16be";
    body = buf.subarray(2);
  }

  if (bom === "utf16le" || bom === "utf16be" || isBinary(body)) {
    return { bom, eol: "lf", eolDominant: "\n", finalNewline: false, encoding: "binary" };
  }

  const text = body.toString("utf8");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  const eol: FileMeta["eol"] = crlf > 0 && lfOnly > 0 ? "mixed" : crlf > 0 ? "crlf" : "lf";
  const eolDominant: "\n" | "\r\n" = crlf >= lfOnly && crlf > 0 ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(text);
  return { bom, eol, eolDominant, finalNewline, encoding: "utf8" };
}

/** Decode file bytes into lines (EOL-agnostic split), stripping BOM. */
export function decodeToLines(buf: Buffer, meta: FileMeta): string[] {
  let body = buf;
  if (meta.bom === "utf8") body = buf.subarray(3);
  let text = body.toString("utf8");
  if (meta.finalNewline) text = text.replace(/\r?\n$/, "");
  return text.split(/\r?\n/);
}

/** Serialize lines back to bytes, preserving EOL/BOM/final newline. */
export function serialize(lines: string[], meta: FileMeta): Buffer {
  const eol = meta.eolDominant;
  let text = lines.join(eol);
  if (meta.finalNewline) text += eol;
  let body = Buffer.from(text, "utf8");
  if (meta.bom === "utf8") body = Buffer.concat([BOM_UTF8, body]);
  return body;
}

export function defaultNewMeta(): FileMeta {
  // Windows-first default for new files.
  const crlf = process.platform === "win32";
  return { bom: null, eol: crlf ? "crlf" : "lf", eolDominant: crlf ? "\r\n" : "\n", finalNewline: true, encoding: "utf8" };
}
