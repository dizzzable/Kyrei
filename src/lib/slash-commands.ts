/**
 * Slash-command registry for Kyrei (skeleton ported from Hermes
 * desktop-slash-commands, content trimmed to Kyrei's real commands).
 *
 * A single spec table is the source of truth. Every downstream concern —
 * execution gating, popover suggestions, canonicalisation, descriptions, and
 * the two-step "takes args" behaviour — derives from it. Each command declares
 * a `surface` discriminator saying how Kyrei fulfils it:
 *
 *   - `action`      → handled by a local client handler (new chat, help, …)
 *   - `picker`      → opens an overlay picker (`/model`)
 *   - `exec`        → runs on the backend and renders inline output
 *   - `unavailable` → a known command with no UI surface; shows a reason
 */

/** Local client action a command resolves to (one handler per id). */
export type SlashActionId = "new" | "help" | "theme" | "settings";

/** A command fulfilled by opening an overlay picker. */
export type SlashPickerId = "model";

/** Why a known command has no interactive surface. */
export type SlashUnavailableReason = "advanced" | "settings";

/** How Kyrei fulfils a command — the single discriminator everything reads. */
export type SlashCommandSurface =
  | { kind: "action"; action: SlashActionId }
  | { kind: "picker"; picker: SlashPickerId }
  | { kind: "exec" }
  | { kind: "unavailable"; reason: SlashUnavailableReason };

export interface SlashCommandSpec {
  /** Canonical command, leading slash included (e.g. `/new`). */
  name: string;
  /** Popover/help label; omitted for unavailable commands (never surfaced). */
  description?: string;
  aliases?: string[];
  surface: SlashCommandSurface;
  /**
   * Hide from the slash popover / completions while still letting it execute.
   * Used for picker commands reachable from chrome (the model picker lives on
   * the status bar), so the popover doesn't dead-end on inline completion.
   */
  hidden?: boolean;
  /**
   * The command has an inline options "screen" (theme list, …). Picking the
   * bare command in the popover expands to that argument step instead of
   * committing — mirroring typing `/<cmd> ` by hand.
   */
  args?: boolean;
}

const action = (id: SlashActionId): SlashCommandSurface => ({ kind: "action", action: id });
const picker = (id: SlashPickerId): SlashCommandSurface => ({ kind: "picker", picker: id });

/**
 * THE source of truth for Kyrei slash commands. Everything below — execution
 * gating, popover suggestions, descriptions, and dispatch — derives from this.
 */
const COMMAND_SPECS: readonly SlashCommandSpec[] = [
  { name: "/new", description: "Start a new chat", aliases: ["/clear", "/reset"], surface: action("new") },
  { name: "/help", description: "Show slash commands", aliases: ["/commands"], surface: action("help") },
  { name: "/model", description: "Switch the model for this session", surface: picker("model"), hidden: true },
  {
    name: "/theme",
    description: "Switch theme or cycle to the next skin",
    aliases: ["/skin"],
    surface: action("theme"),
    args: true,
  },
  { name: "/settings", description: "Open Kyrei settings", surface: action("settings") },
];

const SPEC_BY_NAME = new Map<string, SlashCommandSpec>(COMMAND_SPECS.map((spec) => [spec.name, spec]));

const ALIAS_TO_CANONICAL = new Map<string, string>(
  COMMAND_SPECS.flatMap((spec) => (spec.aliases ?? []).map((alias) => [alias, spec.name] as const)),
);

const UNAVAILABLE_MESSAGE: Record<SlashUnavailableReason, (command: string) => string> = {
  advanced: (command) => `${command} is not available from the slash palette.`,
  settings: (command) => `${command} is managed from Kyrei settings.`,
};

const PICKER_UNAVAILABLE_MESSAGE: Record<SlashPickerId, (command: string) => string> = {
  model: (command) => `${command} uses the model picker instead of a slash command.`,
};

function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const base = (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).split(/\s+/, 1)[0]?.toLowerCase() || "";

  return base;
}

/** Resolve an alias to its canonical name (identity for canonical/unknown). */
export function canonicalSlashCommand(command: string): string {
  const normalized = normalizeCommand(command);

  return ALIAS_TO_CANONICAL.get(normalized) || normalized;
}

/** Resolve a command (or alias) to its spec, or null for unknown commands. */
export function resolveSlashCommand(command: string): SlashCommandSpec | null {
  return SPEC_BY_NAME.get(canonicalSlashCommand(command)) ?? null;
}

function isKnownSlashCommand(command: string): boolean {
  const normalized = normalizeCommand(command);

  return SPEC_BY_NAME.has(normalized) || ALIAS_TO_CANONICAL.has(normalized);
}

/**
 * An "extension" command is anything not one of Kyrei's built-in slash
 * commands — e.g. backend-provided quick commands. They are user-activated, so
 * they appear in the palette and execute when typed.
 */
export function isSlashExtensionCommand(command: string): boolean {
  const normalized = normalizeCommand(command);

  if (!normalized || normalized === "/") {
    return false;
  }

  return !isKnownSlashCommand(normalized);
}

/** Gates execution: true unless the command is a known no-surface command. */
export function isSlashCommand(command: string): boolean {
  const spec = resolveSlashCommand(command);

  if (spec) {
    return spec.surface.kind !== "unavailable";
  }

  return isSlashExtensionCommand(command);
}

/** Gates discovery in the popover/completions. */
export function isSlashSuggestion(command: string): boolean {
  const normalized = normalizeCommand(command);

  // Aliases stay hidden so the popover isn't cluttered with duplicates.
  if (ALIAS_TO_CANONICAL.has(normalized)) {
    return false;
  }

  const spec = SPEC_BY_NAME.get(normalized);

  if (spec) {
    return spec.surface.kind !== "unavailable" && !spec.hidden;
  }

  return isSlashExtensionCommand(normalized);
}

/**
 * True for commands Kyrei fulfils by opening an overlay picker (`/model`).
 * Optionally pin to one picker.
 */
export function isPickerCommand(command: string, id?: SlashPickerId): boolean {
  const surface = resolveSlashCommand(command)?.surface;

  if (surface?.kind !== "picker") {
    return false;
  }

  return id ? surface.picker === id : true;
}

/** Convenience check for the model picker specifically. */
export function isModelPickerCommand(command: string): boolean {
  return isPickerCommand(command, "model");
}

/** A human-readable reason a known command can't be executed inline, or null. */
export function slashUnavailableMessage(command: string): string | null {
  const canonical = canonicalSlashCommand(command);
  const surface = SPEC_BY_NAME.get(canonical)?.surface;

  if (!surface) {
    return null;
  }

  if (surface.kind === "unavailable") {
    return UNAVAILABLE_MESSAGE[surface.reason](canonical);
  }

  if (surface.kind === "picker") {
    return PICKER_UNAVAILABLE_MESSAGE[surface.picker](canonical);
  }

  return null;
}

/** Description for a command (or its alias), falling back to `fallback`. */
export function slashDescription(command: string, fallback = ""): string {
  return SPEC_BY_NAME.get(canonicalSlashCommand(command))?.description || fallback;
}

/**
 * True when picking the bare command should expand to its inline argument
 * options (theme list) rather than committing immediately. Lets the popover act
 * as a two-step picker.
 */
export function slashCommandTakesArgs(command: string): boolean {
  return resolveSlashCommand(command)?.args ?? false;
}
