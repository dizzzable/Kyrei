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
  /** Canonical resource/path or public URL/query available to explicit rules. */
  target?: string;
  destructive?: boolean;
}

const DESTRUCTIVE_RE = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/|mkfs|dd\s+if=|format\s|:\(\)\s*\{|shutdown|reboot)\b/i;
const NETWORK_RE = /\b(curl|wget|nc|ncat|ssh|scp|ftp|Invoke-WebRequest|Invoke-RestMethod)\b/i;

/**
 * Kiro-style protected path match.
 * - pattern ending with `/` or containing `/` (not only basename): path contains
 * - otherwise: exact basename match (case-insensitive on win32)
 */
export function matchesProtectedPath(target: string, patterns: readonly string[]): boolean {
  if (!target || !patterns?.length) return false;
  const normalized = target.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  const ci = process.platform === "win32";
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    const pattern = p.replaceAll("\\", "/");
    if (pattern.includes("/")) {
      const hay = ci ? normalized.toLowerCase() : normalized;
      const needle = ci ? pattern.toLowerCase() : pattern;
      if (hay.includes(needle)) return true;
    } else {
      const left = ci ? base.toLowerCase() : base;
      const right = ci ? pattern.toLowerCase() : pattern;
      if (left === right) return true;
    }
  }
  return false;
}

/** Explicit rules win by deny > ask > allow when multiple match. */
function matchRules(cfg: PermissionConfig, key: string): Decision | null {
  let best: Decision | null = null;
  const rank: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 };
  for (const r of cfg.rules) {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, process.platform === "win32" ? "i" : undefined);
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
  const key = action.command ? `${action.tool}:${action.command}` : action.target ? `${action.tool}:${action.target}` : action.tool;

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

  // Agent-only public web. A precise allow rule may opt one action in while
  // the global mode is off; private/local hosts are blocked by the web client.
  if (action.tool === "web_search") {
    if (cfg.web === "off") return ruled ?? "deny";
    return ruled ?? "allow";
  }
  if (action.tool === "web_fetch") {
    if (cfg.web !== "read") return ruled ?? "deny";
    return ruled ?? "allow";
  }

  // 4. Writes: protected paths always ask (both autopilot and supervised),
  // unless this session already allow-once'd the target.
  if (action.tool === "write_file" || action.tool === "edit_file") {
    if (action.target && matchesProtectedPath(action.target, cfg.protectedPaths ?? [])) {
      const allowOnce = cfg.protectedPathAllowOnce ?? [];
      const norm = action.target.replaceAll("\\", "/");
      const allowed = allowOnce.some((p) => {
        const n = p.replaceAll("\\", "/");
        return n === norm || norm.endsWith(`/${n}`) || n.endsWith(`/${norm}`);
      });
      if (!allowed) return "ask";
    }
    if (cfg.review === "always") return "ask";
    if (ruled === "allow") return "allow";
    return ruled ?? "allow"; // "agent"/"request" let the agent proceed (UI still reviews diffs)
  }

  // MCP: listing is allow-by-default once servers are user-configured;
  // calls default to ask (servers are an attack surface).
  if (action.tool === "mcp_list_tools") {
    return ruled ?? "allow";
  }
  if (action.tool === "mcp_call") {
    return ruled ?? "ask";
  }

  // 5. Read-only tools default allow.
  return ruled ?? "allow";
}

/** Resolve a compound action atomically: any deny wins, then ask, then allow. */
export function decideAll(cfg: PermissionConfig, actions: ActionContext[]): Decision {
  let strongest: Decision = "allow";
  for (const action of actions) {
    const decision = decide(cfg, action);
    if (decision === "deny") return "deny";
    if (decision === "ask") strongest = "ask";
  }
  return strongest;
}
