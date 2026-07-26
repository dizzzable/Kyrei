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
  /**
   * The command text came from the harness (e.g. `diagnostics` picking a
   * verify command out of `detectEcosystem`'s closed set), not from the model.
   * Exempt from the interpreter ask-tier only — that tier exists because a
   * model-supplied one-liner can do anything a denylist cannot anticipate,
   * which does not apply to a command the harness chose itself. Destructive,
   * network and explicit rules still apply.
   */
  trustedSource?: boolean;
}

const DESTRUCTIVE_RE = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/|mkfs|dd\s+if=|format\s|:\(\)\s*\{|shutdown|reboot)\b/i;
const NETWORK_RE = /\b(curl|wget|nc|ncat|ssh|scp|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

/**
 * Commands that route around the two denylists above rather than tripping them.
 *
 * A denylist over free-form shell strings can never be sound — `rm -r -f`,
 * `Remove-Item -Recurse -Force` and `iwr` all miss the patterns above, and an
 * interpreter one-liner or a package install can do anything at all (npm
 * postinstall is arbitrary code execution plus network). These do not get
 * blocked, they get an approval prompt: the point is that the model cannot
 * silently reach outside the workspace through a generic-looking command.
 *
 * Deliberately NOT here: `npm test`, `npm run <script>`, `tsc`, `pytest`, `go
 * build` and friends — the ordinary build/verify loop stays uninterrupted.
 */
const INTERPRETER_RE = new RegExp([
  // Inline interpreter one-liners.
  // `-p` prints an expression and is as capable as `-e`.
  String.raw`\b(?:node|deno|bun)\s+(?:--\S+\s+)*-{1,2}(?:e|eval|print|p)\b`,
  String.raw`\bpython[\d.]*\s+(?:-\S+\s+)*-c\b`,
  // Windows launcher: `py -c "…"`.
  String.raw`\bpy\s+(?:-\S+\s+)*-c\b`,
  String.raw`\b(?:ruby|perl|php)\s+(?:-\S+\s+)*-(?:e|r)\b`,
  // `-\w*[ce]` rather than `-(?:c|…)`: shells accept COMBINED short flags, so
  // `bash -lc '…'` never matched a pattern anchored on a lone `-c`. PowerShell
  // additionally accepts any unambiguous prefix of a parameter name, hence
  // `-Com`, `-enc`, `-ec`.
  String.raw`\b(?:bash|sh|zsh)\s+(?:\S+\s+)*-\w*[ce]\b`,
  String.raw`\b(?:pwsh|powershell)\s+(?:-\S+\s+)*-(?:\w*[ce]|Com\w*|Enc\w*)\b`,
  // cmd.exe was absent entirely: `cmd /c type %USERPROFILE%\.aws\credentials`.
  String.raw`\bcmd(?:\.exe)?\s+/(?:c|k)\b`,
  // Package managers fetching and running third-party code.
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:i|in|install|add|ci|exec|dlx|create)\b`,
  String.raw`\bnpx\b`,
  String.raw`\bpip[\d.]*\s+install\b`,
  String.raw`\b(?:cargo|go)\s+install\b`,
  String.raw`\bgem\s+install\b`,
  // Publishing / pushing outward. `git -C <dir> push` and `git --no-pager push`
  // defeated an adjacency-anchored `git\s+push`.
  String.raw`\bgit\b[^\n;|&]*\spush\b`,
  String.raw`\b(?:npm|pnpm|yarn)\s+publish\b`,
  // Recursive-force deletes the destructive list misses. Order-independent:
  // an earlier version required -r before -f, so `rm -f -r x` slipped through.
  String.raw`\brm\b(?=[^\n;|&]*\s-\w*r)(?=[^\n;|&]*\s-\w*f)`,
  String.raw`\brm\s+(?:--recursive|--force)\b`,
  // `ri` is PowerShell's built-in alias for Remove-Item.
  String.raw`\b(?:Remove-Item|ri)\b[^\n;|&]*-Recurse\b`,
  String.raw`\brd\s+/s\b`,
].join("|"), "i");

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
    const interpreter = action.trustedSource !== true && INTERPRETER_RE.test(cmd);
    if (cfg.terminal === "off") return ruled ?? "ask"; // only allow-listed via rules
    // turbo still gates destructive; an interpreter one-liner or package
    // install is the same class of risk wearing a harmless-looking command.
    // `ruled` is consulted for the interpreter tier here exactly as `auto` does
    // below. Without it turbo — the MORE permissive mode — ignored an explicit
    // allow rule that auto honoured, so a user who clicked "Always allow" on
    // `npm install` got a durable rule that was visible in Settings and never
    // applied, and kept being asked forever.
    if (cfg.terminal === "turbo") {
      if (destructive) return "ask";
      if (interpreter) return ruled ?? "ask";
      return ruled ?? "allow";
    }
    // auto:
    if (destructive) return "ask";
    if (network) return "ask";
    if (interpreter) return ruled ?? "ask";
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

  // Memory writers re-enter the system prompt on every later turn, so a write
  // here is durable influence over the agent, not just a file change.
  // Project scope stays in the workspace and is reviewable like any other write;
  // global scope is cross-workspace and permanent, so it asks by default.
  if (action.tool === "memory_write_project" || action.tool === "memory_write_notes") {
    // `protectedPaths` was checked for write_file/edit_file only, so a user who
    // protected `.kyrei/` got an `ask` on write_file to that path and a SILENT
    // ALLOW on the memory writer that targets the same file. "Reviewable like
    // any other write" was precisely what it was not.
    // An explicit deny has already returned above, so the strongest outcome
    // still available here is `ask`.
    if (action.target && matchesProtectedPath(action.target, cfg.protectedPaths ?? [])) return "ask";
    if (cfg.review === "always") return "ask";
    return ruled ?? "allow";
  }
  if (action.tool === "memory_write_global") {
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
