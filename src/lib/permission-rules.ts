export const PERMISSION_RULE_ACTIONS = ["allow", "ask", "deny"] as const;
export const MAX_PERMISSION_RULE_PATTERN_LENGTH = 512;
export const MAX_PERMISSION_RULES = 128;

export type PermissionRuleAction = typeof PERMISSION_RULE_ACTIONS[number];

export interface PermissionRule {
  pattern: string;
  action: PermissionRuleAction;
}

export type PathPermissionTool = "write_file" | "edit_file";

export type PermissionRuleIssueCode =
  | "rules_not_array"
  | "rule_not_object"
  | "rules_too_many"
  | "pattern_missing"
  | "pattern_too_long"
  | "pattern_control"
  | "pattern_invalid"
  | "action_invalid";

export interface PermissionRuleImportIssue {
  /** -1 means that the imported value itself was not an array. */
  index: number;
  code: PermissionRuleIssueCode;
}

export type PermissionRuleClassification =
  | { mode: "generated"; kind: "tool"; tool: string }
  | { mode: "generated"; kind: "command"; tool: "run_command"; command: string }
  | { mode: "generated"; kind: "path"; tool: PathPermissionTool; target: string }
  | { mode: "advanced"; kind: "advanced" }
  | { mode: "invalid"; kind: "invalid"; error: PermissionRuleIssueCode };

export interface ImportedPermissionRule {
  rule: PermissionRule;
  classification: PermissionRuleClassification;
}

export interface PermissionRulesImportResult {
  /** Valid rules in their original order. Advanced regex rules are retained. */
  rules: PermissionRule[];
  entries: ImportedPermissionRule[];
  issues: PermissionRuleImportIssue[];
}

const ACTION_RANK: Record<PermissionRuleAction, number> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

const EXACT_PATTERN_END = "$(?![\\s\\S])";
const TOOL_SCOPE_SUFFIX = "(?::[\\s\\S]*)?";
const REGEXP_META = new Set(["\\", ".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPermissionRuleAction(value: unknown): value is PermissionRuleAction {
  return typeof value === "string" && (PERMISSION_RULE_ACTIONS as readonly string[]).includes(value);
}

function permissionPatternError(pattern: unknown): PermissionRuleIssueCode | undefined {
  if (typeof pattern !== "string" || pattern.length === 0) return "pattern_missing";
  if (pattern.length > MAX_PERMISSION_RULE_PATTERN_LENGTH) return "pattern_too_long";
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return "pattern_control";
  try {
    // Compilation validates syntax. Import/classification never calls test() on
    // a pattern unless this step has succeeded.
    new RegExp(pattern);
    return undefined;
  } catch {
    return "pattern_invalid";
  }
}

function compilePermissionPattern(pattern: string, caseInsensitive: boolean): RegExp | undefined {
  if (permissionPatternError(pattern)) return undefined;
  try {
    return new RegExp(pattern, caseInsensitive ? "i" : undefined);
  } catch {
    return undefined;
  }
}

function assertTool(tool: string): string {
  if (!tool || tool.length > 128 || tool.includes(":") || /[\0\r\n]/.test(tool)) {
    throw new TypeError("permission_rule_tool_invalid");
  }
  return tool;
}

function exactPattern(key: string): string {
  const pattern = `^${escapePermissionRuleLiteral(key)}${EXACT_PATTERN_END}`;
  if (pattern.length > MAX_PERMISSION_RULE_PATTERN_LENGTH) {
    throw new RangeError("permission_rule_pattern_too_long");
  }
  return pattern;
}

/** Escape a value for literal use in a RegExp constructor pattern. */
export function escapePermissionRuleLiteral(value: string): string {
  let escaped = "";
  for (const character of value) {
    if (REGEXP_META.has(character)) {
      escaped += `\\${character}`;
      continue;
    }
    if (character === "\n") {
      escaped += "\\n";
      continue;
    }
    if (character === "\r") {
      escaped += "\\r";
      continue;
    }
    if (character === "\t") {
      escaped += "\\t";
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      escaped += codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, "0")}`
        : `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (codePoint === 0x2028 || codePoint === 0x2029) {
      escaped += `\\u${codePoint.toString(16)}`;
      continue;
    }
    escaped += character;
  }
  return escaped;
}

/**
 * Build one rule for an exact tool identity. It intentionally accepts that
 * tool's command/target suffix because the backend key is `tool:value` for
 * scoped actions; similarly named tools remain excluded.
 */
export function createExactToolPermissionRule(tool: string, action: PermissionRuleAction): PermissionRule {
  if (!isPermissionRuleAction(action)) throw new TypeError("permission_rule_action_invalid");
  const escapedTool = escapePermissionRuleLiteral(assertTool(tool));
  const pattern = `^${escapedTool}${TOOL_SCOPE_SUFFIX}${EXACT_PATTERN_END}`;
  if (pattern.length > MAX_PERMISSION_RULE_PATTERN_LENGTH) {
    throw new RangeError("permission_rule_pattern_too_long");
  }
  return { pattern, action };
}

/** Build one exact rule for the command string passed to run_command. */
export function createExactCommandPermissionRule(command: string, action: PermissionRuleAction): PermissionRule {
  if (!isPermissionRuleAction(action)) throw new TypeError("permission_rule_action_invalid");
  if (!command || command.includes("\0")) throw new TypeError("permission_rule_command_invalid");
  return { pattern: exactPattern(`run_command:${command}`), action };
}

/**
 * Convert a workspace-relative path to the same slash-separated lexical form
 * used in guarded engine action keys. Absolute and escaping paths fail closed.
 */
export function canonicalizePermissionPathTarget(target: string): string {
  if (!target || target.includes("\0")) throw new TypeError("permission_rule_path_invalid");
  const slashed = target.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw new TypeError("permission_rule_path_absolute");
  }

  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new TypeError("permission_rule_path_escape");
      segments.pop();
      continue;
    }
    if (/[\r\n]/.test(segment)) throw new TypeError("permission_rule_path_invalid");
    segments.push(segment);
  }

  const canonical = segments.join("/");
  if (!canonical) throw new TypeError("permission_rule_path_invalid");
  return canonical;
}

/** Build one exact rule for a canonical write/edit target within the workspace. */
export function createExactPathPermissionRule(
  tool: PathPermissionTool,
  target: string,
  action: PermissionRuleAction,
): PermissionRule {
  if (tool !== "write_file" && tool !== "edit_file") throw new TypeError("permission_rule_path_tool_invalid");
  if (!isPermissionRuleAction(action)) throw new TypeError("permission_rule_action_invalid");
  const canonicalTarget = canonicalizePermissionPathTarget(target);
  return { pattern: exactPattern(`${tool}:${canonicalTarget}`), action };
}

function decodeGeneratedLiteral(value: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      if (REGEXP_META.has(character)) return undefined;
      decoded += character;
      continue;
    }

    const escaped = value[index + 1];
    if (!escaped) return undefined;
    if (REGEXP_META.has(escaped)) {
      decoded += escaped;
      index += 1;
      continue;
    }
    if (escaped === "n" || escaped === "r" || escaped === "t") {
      decoded += escaped === "n" ? "\n" : escaped === "r" ? "\r" : "\t";
      index += 1;
      continue;
    }
    if (escaped === "x") {
      const hex = value.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
      decoded += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    if (escaped === "u") {
      const hex = value.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      decoded += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    return undefined;
  }
  return decoded;
}

function exactLiteralFromPattern(pattern: string): string | undefined {
  if (!pattern.startsWith("^")) return undefined;
  const suffix = pattern.endsWith(EXACT_PATTERN_END)
    ? EXACT_PATTERN_END
    : pattern.endsWith("$")
      ? "$"
      : undefined;
  if (!suffix) return undefined;
  return decodeGeneratedLiteral(pattern.slice(1, -suffix.length));
}

function exactToolFromPattern(pattern: string): string | undefined {
  if (!pattern.startsWith("^") || !pattern.endsWith(`${TOOL_SCOPE_SUFFIX}${EXACT_PATTERN_END}`)) return undefined;
  const encodedTool = pattern.slice(1, -(TOOL_SCOPE_SUFFIX.length + EXACT_PATTERN_END.length));
  return decodeGeneratedLiteral(encodedTool);
}

/** Classify exact guided rules without executing their regex. */
export function classifyPermissionRule(rule: PermissionRule): PermissionRuleClassification {
  if (!isPermissionRuleAction(rule.action)) return { mode: "invalid", kind: "invalid", error: "action_invalid" };
  const patternError = permissionPatternError(rule.pattern);
  if (patternError) return { mode: "invalid", kind: "invalid", error: patternError };

  const scopedTool = exactToolFromPattern(rule.pattern);
  if (scopedTool !== undefined) {
    try {
      if (assertTool(scopedTool) === scopedTool) {
        return { mode: "generated", kind: "tool", tool: scopedTool };
      }
    } catch {
      return { mode: "advanced", kind: "advanced" };
    }
  }

  const literal = exactLiteralFromPattern(rule.pattern);
  if (literal === undefined) return { mode: "advanced", kind: "advanced" };

  if (literal.startsWith("run_command:") && literal.length > "run_command:".length) {
    return {
      mode: "generated",
      kind: "command",
      tool: "run_command",
      command: literal.slice("run_command:".length),
    };
  }

  for (const tool of ["write_file", "edit_file"] as const) {
    const prefix = `${tool}:`;
    if (!literal.startsWith(prefix)) continue;
    const target = literal.slice(prefix.length);
    try {
      if (canonicalizePermissionPathTarget(target) !== target) break;
    } catch {
      break;
    }
    return { mode: "generated", kind: "path", tool, target };
  }

  try {
    if (assertTool(literal) === literal) return { mode: "generated", kind: "tool", tool: literal };
  } catch {
    // A valid but non-guided exact regex remains editable only as advanced text.
  }
  return { mode: "advanced", kind: "advanced" };
}

/** Stable identity for guided rules; useful for duplicate checks without executing imported regex. */
export function guidedPermissionRuleIdentity(
  rule: PermissionRule,
  options: { caseInsensitive?: boolean } = {},
): string | undefined {
  const classification = classifyPermissionRule(rule);
  if (classification.mode !== "generated") return undefined;
  const identity = classification.kind === "command"
    ? `command\0${classification.command}`
    : classification.kind === "path"
      ? `path\0${classification.tool}\0${classification.target}`
      : `tool\0${classification.tool}`;
  return options.caseInsensitive ? identity.toLocaleLowerCase("en-US") : identity;
}

/** Web tools currently deny `ask`; only these guarded tools enter the signed approval flow. */
export function permissionToolSupportsInteractiveAsk(tool: string): boolean {
  return tool === "run_command" || tool === "write_file" || tool === "edit_file" || tool === "diagnostics";
}

/**
 * Validate untrusted persisted/imported rules. Valid advanced regex is kept;
 * malformed entries are reported and omitted, preserving survivor order.
 */
export function importPermissionRules(value: unknown): PermissionRulesImportResult {
  if (!Array.isArray(value)) {
    return { rules: [], entries: [], issues: [{ index: -1, code: "rules_not_array" }] };
  }

  const rules: PermissionRule[] = [];
  const entries: ImportedPermissionRule[] = [];
  const issues: PermissionRuleImportIssue[] = [];
  if (value.length > MAX_PERMISSION_RULES) {
    issues.push({ index: MAX_PERMISSION_RULES, code: "rules_too_many" });
  }
  value.slice(0, MAX_PERMISSION_RULES).forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      issues.push({ index, code: "rule_not_object" });
      return;
    }
    const patternError = permissionPatternError(candidate.pattern);
    if (patternError) {
      issues.push({ index, code: patternError });
      return;
    }
    if (!isPermissionRuleAction(candidate.action)) {
      issues.push({ index, code: "action_invalid" });
      return;
    }
    const rule = { pattern: candidate.pattern as string, action: candidate.action };
    rules.push(rule);
    entries.push({ rule, classification: classifyPermissionRule(rule) });
  });
  return { rules, entries, issues };
}

/** Match one rule after syntax validation; malformed patterns always fail closed. */
export function permissionRuleMatches(
  rule: PermissionRule,
  key: string,
  options: { caseInsensitive?: boolean } = {},
): boolean {
  if (!isPermissionRuleAction(rule.action)) return false;
  const pattern = compilePermissionPattern(rule.pattern, options.caseInsensitive === true);
  return pattern ? pattern.test(key) : false;
}

/** Resolve matching rules with the backend's deny > ask > allow precedence. */
export function resolvePermissionRuleAction(
  rules: readonly PermissionRule[],
  key: string,
  options: { caseInsensitive?: boolean } = {},
): PermissionRuleAction | undefined {
  let strongest: PermissionRuleAction | undefined;
  for (const rule of rules) {
    if (!permissionRuleMatches(rule, key, options)) continue;
    if (!strongest || ACTION_RANK[rule.action] > ACTION_RANK[strongest]) strongest = rule.action;
  }
  return strongest;
}
