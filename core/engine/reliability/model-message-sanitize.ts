/**
 * Canonical AI SDK message ingress.
 *
 * Stored provider history is private implementation data and older releases,
 * foreign imports, or provider adapters may leave parts that no longer match
 * the current ModelMessage schema. Validate at Kyrei's boundary and degrade
 * malformed structures to plain text instead of retrying the same invalid
 * prompt until the self-heal handoff fires.
 */

import { modelMessageSchema, type ModelMessage } from "ai";

export interface SanitizedModelMessages {
  messages: ModelMessage[];
  repaired: number;
  dropped: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textFromUnknown(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => textFromUnknown(part, depth + 1))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  const row = record(value);
  if (!row) return "";

  for (const key of ["text", "content", "message", "parts"]) {
    const text = textFromUnknown(row[key], depth + 1);
    if (text) return text;
  }
  const type = typeof row.type === "string" ? row.type : "";
  const name = typeof row.name === "string"
    ? row.name
    : typeof row.toolName === "string"
      ? row.toolName
      : typeof row.tool_name === "string"
        ? row.tool_name
        : "";
  if (type.includes("tool") || name) return `[tool: ${name || type || "unknown"}]`;
  const fileName = typeof row.filename === "string"
    ? row.filename
    : typeof row.name === "string" && type === "file"
      ? row.name
      : "";
  if (fileName) return `[file: ${fileName}]`;
  return "";
}

function repairMessage(value: unknown): ModelMessage | null {
  const row = record(value);
  if (!row) return null;
  const role = row.role;
  if (role !== "system" && role !== "user" && role !== "assistant") return null;
  const content = textFromUnknown(row.content ?? row.text ?? row.parts);
  if (!content && role !== "assistant") return null;
  return { role, content } as ModelMessage;
}

export function sanitizeModelMessages(value: unknown): SanitizedModelMessages {
  const input = Array.isArray(value) ? value : [];
  const messages: ModelMessage[] = [];
  let repaired = 0;
  let dropped = 0;

  for (const candidate of input) {
    const parsed = modelMessageSchema.safeParse(candidate);
    if (parsed.success) {
      messages.push(parsed.data);
      continue;
    }
    const repairedMessage = repairMessage(candidate);
    if (repairedMessage && modelMessageSchema.safeParse(repairedMessage).success) {
      messages.push(repairedMessage);
      repaired += 1;
    } else {
      dropped += 1;
    }
  }

  return { messages, repaired, dropped };
}
