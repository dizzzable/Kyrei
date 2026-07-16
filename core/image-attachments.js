/**
 * Persist user-attached images and build model message content
 * (native multimodal parts vs text-only labels).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_PROMPT_IMAGES = 6;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB decoded
const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/**
 * @typedef {{ name?: string, mediaType?: string, data?: string, path?: string }} RawImageInput
 * @typedef {{ id: string, name: string, mediaType: string, relPath: string, bytes: number }} StoredImageRef
 */

/**
 * Normalize + validate prompt image payload from the client.
 * @param {unknown} raw
 * @returns {{ images: Array<{ name: string, mediaType: string, buffer: Buffer }>, errors: string[] }}
 */
export function normalizePromptImages(raw) {
  const errors = [];
  if (raw == null) return { images: [], errors };
  if (!Array.isArray(raw)) {
    return { images: [], errors: ["images_not_array"] };
  }
  if (raw.length > MAX_PROMPT_IMAGES) {
    return { images: [], errors: ["images_too_many"] };
  }
  /** @type {Array<{ name: string, mediaType: string, buffer: Buffer }>} */
  const images = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i];
    if (!row || typeof row !== "object") {
      errors.push(`images.${i}.invalid`);
      continue;
    }
    let mediaType = typeof row.mediaType === "string" ? row.mediaType.trim().toLowerCase() : "";
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    if (!ALLOWED_MEDIA.has(mediaType)) {
      errors.push(`images.${i}.media_type`);
      continue;
    }
    const data = typeof row.data === "string" ? row.data.trim() : "";
    if (!data) {
      errors.push(`images.${i}.data`);
      continue;
    }
    // Strip optional data-URL prefix
    const b64 = data.includes(",") && data.startsWith("data:")
      ? data.slice(data.indexOf(",") + 1)
      : data;
    let buffer;
    try {
      buffer = Buffer.from(b64, "base64");
    } catch {
      errors.push(`images.${i}.base64`);
      continue;
    }
    if (!buffer.length) {
      errors.push(`images.${i}.empty`);
      continue;
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      errors.push(`images.${i}.too_large`);
      continue;
    }
    const name = typeof row.name === "string" && row.name.trim()
      ? row.name.trim().slice(0, 200)
      : `image-${i + 1}${extForMedia(mediaType)}`;
    images.push({ name, mediaType, buffer });
  }
  if (errors.length && !images.length) return { images: [], errors };
  return { images, errors };
}

function extForMedia(mediaType) {
  if (mediaType === "image/png") return ".png";
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/gif") return ".gif";
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "image/bmp") return ".bmp";
  return ".bin";
}

/**
 * Write image buffers under attachmentsRoot/sessionId/.
 * @returns {Promise<StoredImageRef[]>}
 */
export async function persistPromptImages(attachmentsRoot, sessionId, images) {
  const safeSession = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const dir = join(attachmentsRoot, safeSession);
  await mkdir(dir, { recursive: true });
  /** @type {StoredImageRef[]} */
  const out = [];
  for (const img of images) {
    const id = randomUUID().slice(0, 12);
    const ext = extForMedia(img.mediaType);
    const fileName = `${id}${ext}`;
    const abs = join(dir, fileName);
    await writeFile(abs, img.buffer);
    out.push({
      id,
      name: img.name,
      mediaType: img.mediaType,
      relPath: join(safeSession, fileName).replaceAll("\\", "/"),
      bytes: img.buffer.length,
    });
  }
  return out;
}

/**
 * Build display text appendix for attachments (always).
 * @param {StoredImageRef[]} refs
 */
export function imageAttachmentDisplayText(refs) {
  if (!refs?.length) return "";
  return refs.map((r) => `[image: ${r.name}]`).join(" ");
}

/**
 * Build AI SDK user message content for a prompt with optional images.
 * @param {string} text
 * @param {StoredImageRef[]} refs
 * @param {"native"|"text"} presentation
 * @param {string} attachmentsRoot
 * @returns {Promise<string | Array<Record<string, unknown>>>}
 */
export async function buildUserMessageContent(text, refs, presentation, attachmentsRoot) {
  const body = typeof text === "string" ? text : "";
  if (!refs?.length) return body;

  if (presentation !== "native") {
    const labels = refs.map((r) => `- ${r.name} (${r.mediaType}, ${r.bytes} bytes)`).join("\n");
    const note = [
      body,
      "",
      "[Attached images — model does not receive pixels in text mode; paths are labels only]",
      labels,
    ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
    return note.trim();
  }

  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  if (body.trim()) parts.push({ type: "text", text: body });
  for (const ref of refs) {
    try {
      const abs = join(attachmentsRoot, ref.relPath);
      const bytes = await readFile(abs);
      // AI SDK image part: data URL or Uint8Array
      const dataUrl = `data:${ref.mediaType};base64,${bytes.toString("base64")}`;
      parts.push({ type: "image", image: dataUrl, mediaType: ref.mediaType });
    } catch {
      parts.push({
        type: "text",
        text: `[image missing: ${ref.name}]`,
      });
    }
  }
  return parts.length === 1 && parts[0].type === "text"
    ? String(parts[0].text)
    : parts;
}

/**
 * Rebuild user content for history from stored message fields.
 */
export async function userContentFromStoredMessage(message, attachmentsRoot, forcePresentation) {
  const text = typeof message?.content === "string" ? message.content : "";
  const refs = Array.isArray(message?.imageAttachments) ? message.imageAttachments : [];
  if (!refs.length) return text;
  const presentation = forcePresentation
    || (message.imagePresentation === "native" ? "native" : "text");
  // Strip prior display suffixes from content if present — content is already clean display text
  return buildUserMessageContent(text, refs, presentation, attachmentsRoot);
}

export function attachmentDirFor(dataDir) {
  return join(dataDir, "chat-attachments");
}

// re-export dirname for tests that mock path
export { dirname };
