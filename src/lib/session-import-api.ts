/**
 * Client helper for conversation import (file → gateway → handoff/LTM/seed session).
 */

import { gateway } from "@/lib/gateway";

// Gateway JSON bodies are capped at 20 MiB; base64 expands by ~4/3.
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

export type SessionImportResult = Awaited<ReturnType<typeof gateway.importTranscript>>;

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function importConversationFile(
  file: File,
  options: {
    adapterId?: string;
    createSession?: boolean;
    writeLtm?: boolean;
  } = {},
): Promise<SessionImportResult> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error("import_payload_too_large");
  }
  const buffer = await file.arrayBuffer();
  return gateway.importTranscript({
    fileName: file.name,
    contentBase64: bufferToBase64(buffer),
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    options: {
      createSession: options.createSession !== false,
      writeLtm: options.writeLtm !== false,
      writeHandoff: true,
      dedupe: true,
    },
  });
}
