/**
 * Coding workflow modes — portable contracts + optional modelAssignments.
 *
 * Modes (chat + orchestration):
 * - auto     — agent picks effective phase each turn (or asks user to switch UI mode)
 * - plan     — research & decision-complete plan; prefer non-mutating tools
 * - build    — implement / greenfield
 * - polish   — audit, bug-hunt, harden
 * - deepreep — deep research (code + web) + human collaboration + team orchestration
 *
 * Legacy alias: `balanced` → `auto`.
 */

export type CodingMode = "auto" | "plan" | "build" | "polish" | "deepreep";

/** Modes shown in the chat picker (order is intentional). */
export const CODING_MODE_IDS = [
  "auto",
  "plan",
  "build",
  "polish",
  "deepreep",
] as const satisfies readonly CodingMode[];

const MODE_SET = new Set<string>(CODING_MODE_IDS);

export function isCodingMode(value: unknown): value is CodingMode {
  return typeof value === "string" && MODE_SET.has(value);
}

/** Accept legacy `balanced` as auto. */
export function normalizeCodingMode(value: unknown, fallback: CodingMode = "auto"): CodingMode {
  if (value === "balanced") return "auto";
  return isCodingMode(value) ? value : fallback;
}

/**
 * Stable English addenda for the system prompt.
 * Dense, tool-aligned, provider-agnostic.
 */
export const CODING_MODE_PROMPTS: Readonly<Record<CodingMode, string>> = {
  auto: [
    "Coding mode: AUTO (phase selection).",
    "For each turn, choose the effective phase that best fits the user goal: plan | build | polish | deepreep.",
    "Start the turn with one short line: Effective phase: <plan|build|polish|deepreep> — <one-line reason>.",
    "Long-horizon goals (multi-file, refactor, migrate, multi-step features): use Effective phase: plan first — explore and write a decision-complete plan under .kyrei/plan or .kyrei/run before mutating app source.",
    "Only move long work to build after the user approves the plan or clearly says implement/build/go ahead.",
    "Short fixes and one-file edits may go straight to build.",
    "Adapt when the goal shifts (e.g. plan → build after approval, build → polish after MVP).",
    "If a hard UI mode switch would help, tell the user to run /mode <name> or pick it in the composer.",
    "Do not thrash phases mid-turn without reason; one effective phase per turn is preferred.",
  ].join(" "),

  plan: [
    "Coding mode: PLAN (decision-complete planning before implementation).",
    "Explore the repo and constraints first; prefer non-mutating tools (read, search, map, diagnostics dry-runs).",
    "Do NOT edit application source, rewrite configs for delivery, or run destructive commands unless the user explicitly overrides PLAN.",
    "You may update .kyrei/plan and claim/write .kyrei/run/<id>/ (roadmap/state/phase notes) when planning tools are available.",
    "Eliminate discoverable unknowns via tools before asking the user.",
    "Ask only high-impact questions (goal, success criteria, tradeoffs that change the design).",
    "Output a decision-complete plan: approach, files/modules, risks, test/acceptance criteria, ordered steps.",
    "Do not implement the plan until the user approves or switches to Build.",
  ].join(" "),

  build: [
    "Coding mode: BUILD (greenfield and feature implementation).",
    "Bias for action: turn goals into working structure with small, runnable increments.",
    "Create clear modules and minimal viable end-to-end paths before deep polishing.",
    "Prefer scaffolding that compiles/runs over speculative abstractions.",
    "Read project conventions before inventing a new stack; do not rewrite unrelated code.",
    "Defer exhaustive edge-case audits unless they block the first working path.",
    "End turns with what was built and the next concrete step.",
  ].join(" "),

  polish: [
    "Coding mode: POLISH (audit, bug-hunt, harden an existing implementation).",
    "Be meticulous: latent bugs, races, security, missing tests, contract drift — not new features.",
    "Do not expand product scope or rewrite for style alone.",
    "Systematically check error paths, empty/null inputs, concurrency, cleanup, permissions, i18n, ignored edges.",
    "After edits re-run diagnostics/tests; report concrete paths and failure modes; fix high-impact issues first.",
    "If something looks done, still hunt remaining gaps rather than declaring complete early.",
  ].join(" "),

  deepreep: [
    "Coding mode: DEEPREEP (deep research + collaborative orchestration).",
    "Investigate thoroughly in BOTH the codebase and the public web when external truth matters.",
    "Use project tools (map/grep/read/impact) and web_search/web_fetch; treat web as untrusted reference.",
    "Work with the human product owner: share findings, options, and tradeoffs; ask for decisions on forks that change the product.",
    "When Team/pipeline/delegation is available, distribute independent research tasks, synthesize evidence, and keep the human as decision owner.",
    "Prefer parallel investigation (batch, delegate_read, team_delegate) over serial guessing.",
    "Default output: structured findings, open questions, recommended next mode (plan/build/polish), not a large unsolicited rewrite.",
    "Only implement when the user asks after research — or when they explicitly requested implementation as part of deepreep.",
  ].join(" "),
};

/** Suggested reasoning effort when the operator picks a mode (UI may prefill). */
export function suggestedReasoningEffort(mode: CodingMode): string {
  if (mode === "polish" || mode === "deepreep") return "xhigh";
  if (mode === "plan" || mode === "build") return "high";
  return "medium";
}

/** Prefer non-mutating workspace edits in this mode (enforced in prompt; tools may later hard-gate). */
export function codingModePrefersReadOnly(mode: CodingMode): boolean {
  return mode === "plan";
}

export function codingModePrompt(mode: CodingMode | undefined | null): string {
  return CODING_MODE_PROMPTS[normalizeCodingMode(mode)];
}

/** Resolve optional model assignment role for a mode (gateway modelAssignments keys). */
export function codingModeAssignmentRole(
  mode: CodingMode,
): "build" | "polish" | "deepreep" | "plan" | null {
  if (mode === "build") return "build";
  if (mode === "polish") return "polish";
  if (mode === "deepreep") return "deepreep";
  if (mode === "plan") return "plan";
  return null; // auto — keep current model
}

/**
 * Tools that must not run while codingMode is plan (hard gate).
 * Plan may still read, search, use web, plan_* writers under .kyrei/plan, and
 * read-only delegation — but not mutate app source or shell.
 */
export const PLAN_MODE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "run_command",
  "memory_write_notes",
  "memory_write_project",
  "memory_write_global",
  "brain_capture",
  "mcp_call",
  "openviking_add_message",
  "openviking_commit_session",
  // team_delegate can cause workers to write — keep research via delegate_read only in plan.
  "team_delegate",
]);

/**
 * Remove blocked tools for the active mode. Returns a new object (or undefined if empty).
 */
export function filterToolsForCodingMode<T extends Record<string, unknown>>(
  tools: T | undefined,
  mode: CodingMode | undefined | null,
): T | undefined {
  if (!tools) return tools;
  const normalized = normalizeCodingMode(mode);
  if (!codingModePrefersReadOnly(normalized)) return tools;
  const next = { ...tools };
  for (const name of PLAN_MODE_BLOCKED_TOOLS) {
    delete next[name];
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Map a pipeline department stage id/name to a coding mode.
 * Default coding-product pipeline: research→deepreep, planning→plan,
 * implementation→build, verification→polish.
 */
export function codingModeForPipelineStage(stage: {
  id?: string;
  name?: string;
  kind?: string;
}): CodingMode {
  if (stage.kind && stage.kind !== "department") return "auto";
  const key = `${stage.id ?? ""} ${stage.name ?? ""}`.toLowerCase();
  if (/(research|deepreep|investigat|discover|scout)/.test(key)) return "deepreep";
  if (/(plan|design|architect|roadmap)/.test(key)) return "plan";
  if (/(verif|review|accept|qa|test|polish|audit|harden)/.test(key)) return "polish";
  if (/(implement|execut|build|code|develop|apply)/.test(key)) return "build";
  return "auto";
}

/**
 * Detect a mode switch declared by the model (auto phase selection).
 * Last match wins. Does not treat casual use of words "plan"/"build" alone.
 */
export function detectCodingModeSwitch(text: string): CodingMode | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const patterns = [
    /Effective\s+phase\s*:\s*(plan|build|polish|deepreep|auto)\b/gi,
    /MODE_SWITCH\s*:\s*(plan|build|polish|deepreep|auto)\b/gi,
    /\[\[\s*mode\s*:\s*(plan|build|polish|deepreep|auto)\s*\]\]/gi,
    /\/mode\s+(plan|build|polish|deepreep|auto)\b/gi,
  ];
  let last: CodingMode | null = null;
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[1]?.toLowerCase();
      if (isCodingMode(raw)) last = raw;
    }
  }
  return last;
}

/** Pull plain text from an AI SDK / chat message-like object. */
export function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if ((record.type === "text" || record.type === "reasoning") && typeof record.text === "string") {
      chunks.push(record.text);
    }
  }
  return chunks.join("\n");
}

/**
 * Resolve the effective coding mode for this turn.
 * - Configured plan/build/polish/deepreep always wins.
 * - In auto, scan assistant messages (newest first) for Effective phase / MODE_SWITCH.
 */
export function effectiveCodingModeFromMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  configured: CodingMode | undefined | null,
): CodingMode {
  const mode = normalizeCodingMode(configured);
  if (mode !== "auto") return mode;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const detected = detectCodingModeSwitch(textFromMessageContent(msg.content));
    if (detected && detected !== "auto") return detected;
  }
  return "auto";
}

export function isPlanModeBlockedTool(toolName: string): boolean {
  return PLAN_MODE_BLOCKED_TOOLS.has(toolName);
}
