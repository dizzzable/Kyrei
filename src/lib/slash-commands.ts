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

import type { Translator } from "@/i18n/types";
import type { enChat } from "@/i18n/locales/en/chat";

export type ChatTranslationKey = Extract<keyof typeof enChat, string>;
export type ChatTranslator = Translator<ChatTranslationKey>;

/** Local client action a command resolves to (one handler per id). */
export type SlashActionId = "new" | "help" | "theme" | "settings" | "mode";
export type SlashCommandId = SlashActionId | SlashPickerId;

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
  /** Stable locale-neutral id used by UI registries. */
  id: SlashCommandId;
  /** Canonical command, leading slash included (e.g. `/new`). */
  name: string;
  /** Catalog key resolved only at the rendering edge. */
  descriptionKey: ChatTranslationKey;
  argKey?: ChatTranslationKey;
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
export const SLASH_COMMAND_REGISTRY: readonly SlashCommandSpec[] = [
  { id: "new", name: "/new", descriptionKey: "chat.slash.new.description", aliases: ["/clear", "/reset"], surface: action("new") },
  { id: "help", name: "/help", descriptionKey: "chat.slash.help.description", aliases: ["/commands"], surface: action("help") },
  { id: "model", name: "/model", descriptionKey: "chat.slash.model.description", argKey: "chat.slash.model.arg", surface: picker("model"), hidden: true },
  {
    id: "theme",
    name: "/theme",
    descriptionKey: "chat.slash.theme.description",
    argKey: "chat.slash.theme.arg",
    aliases: ["/skin"],
    surface: action("theme"),
    args: true,
  },
  { id: "settings", name: "/settings", descriptionKey: "chat.slash.settings.description", surface: action("settings") },
  {
    id: "mode",
    name: "/mode",
    descriptionKey: "chat.slash.mode.description",
    argKey: "chat.slash.mode.arg",
    aliases: ["/coding-mode", "/phase"],
    surface: action("mode"),
    args: true,
  },
];

const SPEC_BY_NAME = new Map<string, SlashCommandSpec>(SLASH_COMMAND_REGISTRY.map((spec) => [spec.name, spec]));

const ALIAS_TO_CANONICAL = new Map<string, string>(
  SLASH_COMMAND_REGISTRY.flatMap((spec) => (spec.aliases ?? []).map((alias) => [alias, spec.name] as const)),
);

export interface LocalizedSlashCommand {
  id: SlashCommandId;
  /** Bare command name retained for the existing App onCommand contract. */
  name: string;
  /** Canonical command including the leading slash. */
  command: string;
  desc: string;
  arg?: string;
}

function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const base = (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).split(/\s+/, 1)[0]?.toLowerCase() || "";

  return base;
}

/** Parse user input while retaining the legacy bare-name dispatch contract. */
export function parseSlash(input: string): { name: string; arg: string } {
  const match = input.replace(/^\/+/, "").match(/^(\S+)\s*([\s\S]*)$/);
  return match ? { name: match[1].toLowerCase(), arg: match[2].trim() } : { name: "", arg: "" };
}

/** Resolve the visible slash palette from the locale-neutral source registry. */
export function getSlashCommands(t: ChatTranslator): LocalizedSlashCommand[] {
  return SLASH_COMMAND_REGISTRY
    .filter((spec) => spec.surface.kind !== "unavailable" && !spec.hidden)
    .map((spec) => ({
      id: spec.id,
      name: spec.name.slice(1),
      command: spec.name,
      desc: t(spec.descriptionKey),
      ...(spec.argKey ? { arg: t(spec.argKey) } : {}),
    }));
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
export function slashUnavailableMessage(command: string, t: ChatTranslator): string | null {
  const canonical = canonicalSlashCommand(command);
  const surface = SPEC_BY_NAME.get(canonical)?.surface;

  if (!surface) {
    return null;
  }

  if (surface.kind === "unavailable") {
    return t(`chat.slash.unavailable.${surface.reason}`, { command: canonical });
  }

  if (surface.kind === "picker") {
    return t("chat.slash.unavailable.model", { command: canonical });
  }

  return null;
}

/** Description for a command (or its alias), falling back to `fallback`. */
export function slashDescription(command: string, t: ChatTranslator, fallback = ""): string {
  const key = SPEC_BY_NAME.get(canonicalSlashCommand(command))?.descriptionKey;
  return key ? t(key) : fallback;
}

/**
 * True when picking the bare command should expand to its inline argument
 * options (theme list) rather than committing immediately. Lets the popover act
 * as a two-step picker.
 */
export function slashCommandTakesArgs(command: string): boolean {
  return resolveSlashCommand(command)?.args ?? false;
}
