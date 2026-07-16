/**
 * Build durable engine permission rules from an approval tool call
 * (gateway-side; mirrors src/lib/permission-rules.ts builders).
 */

const EXACT_PATTERN_END = "$(?![\\s\\S])";
const TOOL_SCOPE_SUFFIX = "(?::[\\s\\S]*)?";
const REGEXP_META = new Set(["\\", ".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]"]);
const MAX_PATTERN = 512;
const MAX_RULES = 128;

function escapeLiteral(value) {
  let escaped = "";
  for (const character of value) {
    if (REGEXP_META.has(character)) {
      escaped += `\\${character}`;
      continue;
    }
    escaped += character;
  }
  return escaped;
}

function exactPattern(key) {
  const pattern = `^${escapeLiteral(key)}${EXACT_PATTERN_END}`;
  if (pattern.length > MAX_PATTERN) throw new RangeError("permission_rule_pattern_too_long");
  return pattern;
}

function assertTool(tool) {
  if (!tool || tool.length > 128 || tool.includes(":") || /[\0\r\n]/.test(tool)) {
    throw new TypeError("permission_rule_tool_invalid");
  }
  return tool;
}

export function createExactToolPermissionRule(tool, action) {
  const escapedTool = escapeLiteral(assertTool(tool));
  const pattern = `^${escapedTool}${TOOL_SCOPE_SUFFIX}${EXACT_PATTERN_END}`;
  if (pattern.length > MAX_PATTERN) throw new RangeError("permission_rule_pattern_too_long");
  return { pattern, action };
}

export function createExactCommandPermissionRule(command, action) {
  if (!command || command.includes("\0")) throw new TypeError("permission_rule_command_invalid");
  return { pattern: exactPattern(`run_command:${command}`), action };
}

export function canonicalizePermissionPathTarget(target) {
  if (!target || target.includes("\0")) throw new TypeError("permission_rule_path_invalid");
  const slashed = target.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw new TypeError("permission_rule_path_absolute");
  }
  const segments = [];
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

export function createExactPathPermissionRule(tool, target, action) {
  if (tool !== "write_file" && tool !== "edit_file") throw new TypeError("permission_rule_path_tool_invalid");
  const canonicalTarget = canonicalizePermissionPathTarget(target);
  return { pattern: exactPattern(`${tool}:${canonicalTarget}`), action };
}

/**
 * @param {string} toolName
 * @param {unknown} args
 * @param {"allow"|"deny"|"ask"} action
 * @returns {{ pattern: string, action: string } | null}
 */
export function permissionRuleFromApproval(toolName, args, action) {
  if (action !== "allow" && action !== "deny" && action !== "ask") return null;
  const name = typeof toolName === "string" ? toolName.trim() : "";
  if (!name) return null;
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  try {
    if (name === "run_command") {
      const command = typeof a.command === "string" ? a.command.trim() : "";
      // Always-allow must not promote a tool-wide "any command" rule from empty/invalid targets.
      if (!command) return action === "allow" ? null : createExactToolPermissionRule("run_command", action);
      return createExactCommandPermissionRule(command, action);
    }
    if (name === "write_file" || name === "edit_file") {
      const path = typeof a.path === "string" ? a.path : typeof a.file === "string" ? a.file : "";
      if (!path.trim()) return action === "allow" ? null : createExactToolPermissionRule(name, action);
      try {
        return createExactPathPermissionRule(name, path.trim(), action);
      } catch {
        // Absolute/non-workspace paths: refuse silent tool-wide Always allow.
        return action === "allow" ? null : createExactToolPermissionRule(name, action);
      }
    }
    return createExactToolPermissionRule(name, action);
  } catch {
    return null;
  }
}

const RANK = { allow: 1, ask: 2, deny: 3 };

export function mergePermissionRule(rules, candidate) {
  const list = Array.isArray(rules) ? [...rules] : [];
  if (list.some((r) => r.pattern === candidate.pattern && r.action === candidate.action)) {
    return list;
  }
  let replaced = false;
  const next = list.map((r) => {
    if (r.pattern !== candidate.pattern) return r;
    replaced = true;
    const cur = RANK[r.action] ?? 0;
    const neu = RANK[candidate.action] ?? 0;
    return neu >= cur ? candidate : r;
  });
  if (replaced) return next;
  if (next.length >= MAX_RULES) return next;
  return [...next, candidate];
}
