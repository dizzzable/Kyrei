import { isRecord } from "../decode.js";
import type { ImportMessageRole, ImportedMessage } from "../types.js";

export function importedRole(value: unknown): ImportMessageRole {
  if (value === "user" || value === "human") return "user";
  if (value === "assistant" || value === "model" || value === "agent") return "assistant";
  if (value === "tool" || value === "function") return "tool";
  if (value === "system" || value === "developer") return "system";
  return "unknown";
}

export function importedText(value: unknown, depth = 0): string {
  if (depth > 5) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((part) => importedText(part, depth + 1)).filter(Boolean).join("\n").trim();
  }
  if (!isRecord(value)) return "";
  for (const key of ["text", "content", "message", "value", "parts"]) {
    const text = importedText(value[key], depth + 1);
    if (text) return text;
  }
  const type = typeof value.type === "string" ? value.type : "";
  const name = typeof value.name === "string"
    ? value.name
    : typeof value.tool_name === "string"
      ? value.tool_name
      : typeof value.toolName === "string"
        ? value.toolName
        : "";
  if (type.includes("tool") || type.includes("function") || name) {
    return `[tool:${name || type || "unknown"}]`;
  }
  return "";
}

export function isoTime(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const ms = value < 10_000_000_000 ? value * 1_000 : value;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/** Imported system/developer prompts are metadata, never executable policy. */
export function importedConversationMessage(value: unknown): ImportedMessage | null {
  if (!isRecord(value)) return null;
  const author = isRecord(value.author) ? value.author : null;
  const role = importedRole(value.role ?? author?.role ?? value.type);
  if (role === "system" || role === "unknown") return null;
  let text = importedText(value.content ?? value.text ?? value.parts);
  const toolName = typeof value.tool_name === "string"
    ? value.tool_name
    : typeof value.name === "string"
      ? value.name
      : "";
  if (role === "tool" && toolName) text = `[tool:${toolName}]${text ? `\n${text}` : ""}`;
  text = text.trim();
  if (!text) return null;
  return {
    role,
    text,
    ...(isoTime(value.timestamp ?? value.created_at ?? value.createdAt) ? {
      at: isoTime(value.timestamp ?? value.created_at ?? value.createdAt),
    } : {}),
  };
}
