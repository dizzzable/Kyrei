const INTERNAL_ASSISTANT_LINE = /^\s*(?:MODE_SWITCH\s*:\s*(?:plan|build|polish|deepreep|auto)\b.*|Effective\s+phase\s*:\s*(?:plan|build|polish|deepreep|auto)\b.*|\[(?:goal-verify|verify-before-done)\].*)\s*$/i;
const LEADING_MODE_SWITCH = /^\s*MODE_SWITCH\s*:\s*(?:plan|build|polish|deepreep|auto)/i;

export function isInternalAssistantDisplayLine(line: string): boolean {
  return INTERNAL_ASSISTANT_LINE.test(line);
}

export function sanitizeAssistantDisplayText(text: string): string {
  if (typeof text !== "string" || !text.trim()) return "";
  // Some OpenAI-compatible streaming gateways collapse the protocol line and
  // the first text delta (`MODE_SWITCH:buildVisible answer`) instead of
  // preserving the mandated newline. The mode value is finite and the marker
  // is allowed only at the start, so remove it before line-level filtering.
  const withoutLeadingModeSwitch = text.replace(LEADING_MODE_SWITCH, "");
  const kept = withoutLeadingModeSwitch
    .split(/\r?\n/)
    .filter((line) => !isInternalAssistantDisplayLine(line));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
