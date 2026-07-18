const INTERNAL_ASSISTANT_LINE = /^\s*(?:MODE_SWITCH\s*:\s*(?:plan|build|polish|deepreep|auto)\b.*|Effective\s+phase\s*:\s*(?:plan|build|polish|deepreep|auto)\b.*|\[(?:goal-verify|verify-before-done)\].*)\s*$/i;

export function isInternalAssistantDisplayLine(line: string): boolean {
  return INTERNAL_ASSISTANT_LINE.test(line);
}

export function sanitizeAssistantDisplayText(text: string): string {
  if (typeof text !== "string" || !text.trim()) return "";
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !isInternalAssistantDisplayLine(line));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
