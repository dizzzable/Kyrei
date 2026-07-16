import { ImportError } from "./errors.js";
import { IMPORT_MAX_BYTES, type ImportRawInput } from "./types.js";

export function assertImportSize(bytes: Uint8Array): void {
  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    throw new ImportError(
      "import_payload_too_large",
      `payload ${bytes.byteLength} bytes exceeds ${IMPORT_MAX_BYTES}`,
    );
  }
}

export function decodeImportText(input: ImportRawInput): string {
  if (typeof input.text === "string") return input.text;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  } catch {
    throw new ImportError("import_invalid_input", "failed to decode UTF-8 text");
  }
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
