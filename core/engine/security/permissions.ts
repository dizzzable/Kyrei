/**
 * Permission engine (Requirements §8.2, §8.3). Two-axis autonomy
 * (terminal off/auto/turbo × review always/agent/request) + allow/ask/deny rules
 * with deny-wins precedence. Restrictive defaults; destructive → ask/deny.
 */

import type { PermissionConfig } from "../types.js";

export type Decision = "allow" | "ask" | "deny";

export interface ActionContext {
  tool: string; // e.g. "run_command", "write_file", "edit_file"
  command?: string; // for run_command
  destructive?: boolean;
}

const DESTRUCTIVE_RE = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/|mkfs|dd\s+if=|format\s|:\(\)\s*\{|shutdown|reboot)\b/i;
const NETWORK_RE = /\b(curl|wget|nc|ncat|ssh|scp|ftp|Invoke-WebRequest|Invoke-RestMethod)\b/i;

/** Explicit rules win by deny > ask > allow when multiple match. */
function matchRules(cfg: PermissionConfig, key: string): Decision | null {
  let best: Decision | null = null;
  const rank: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 };
  for (const r of cfg.rules) {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern);
    } catch {
      continue;
    }
    if (re.test(key)) {
      if (best === null || rank[r.action] > rank[best]) best = r.action;
    }
  }
  return best;
}

export function decide(cfg: PermissionConfig, action: ActionContext): Decision {
  const key = action.command ? `${action.tool}:${action.command}` : action.tool;

  // 1. Explicit rules (deny-wins).
  const ruled = matchRules(cfg, key);
  if (ruled === "deny") return "deny";

  // 2. Terminal policy for command execution.
  if (action.tool === "run_command") {
    const cmd = action.command ?? "";
    const destructive = action.destructive || DESTRUCTIVE_RE.test(cmd);
    const network = NETWORK_RE.test(cmd);
    if (cfg.terminal === "off") return ruled ?? "ask"; // only allow-listed via rules
    if (cfg.terminal === "turbo") return destructive ? "ask" : (ruled ?? "allow"); // turbo still gates destructive
    // auto:
    if (destructive) return "ask";
    if (network) return "ask";
    return ruled ?? "allow";
  }

  // 3. Writes: gate by review policy.
  if (action.tool === "write_file" || action.tool === "edit_file") {
    if (ruled === "allow") return "allow";
    if (cfg.review === "always") return "ask";
    return ruled ?? "allow"; // "agent"/"request" let the agent proceed (UI still reviews diffs)
  }

  // 4. Read-only tools default allow.
  return ruled ?? "allow";
}
