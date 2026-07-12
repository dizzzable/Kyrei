// The single source of truth for rebindable Kyrei hotkeys.
//
// Each entry is pure metadata: an id, a category, and the default combo(s).
// Handlers are wired separately in React land (they need navigate / theme /
// store context); labels come from i18n. To add a hotkey, add a row here and a
// handler there — nothing else.
//
// Pruned for Kyrei: no profiles / terminals / pets / review / worktree /
// messaging / cron / agents. Only the categories and actions relevant to the
// current surface remain.

export type KeybindCategory = "composer" | "session" | "navigation" | "view";

// The self-referential opener — bound + dispatched like any action, but shown in
// the panel subtitle (not as its own row).
export const KEYBIND_PANEL_ACTION = "keybinds.openPanel";

// `composer` is read-only; the rest are rebindable. `view` is the catch-all for
// layout, appearance, and the panel-opener.
export const KEYBIND_CATEGORIES: readonly KeybindCategory[] = [
  "composer",
  "session",
  "navigation",
  "view",
];

export interface KeybindActionMeta {
  id: string;
  category: KeybindCategory;
  /** Default combos. Empty = shipped unbound (user can assign one). */
  defaults: readonly string[];
}

export const KEYBIND_ACTIONS: readonly KeybindActionMeta[] = [
  // ── Composer ─────────────────────────────────────────────────────────────
  { id: "composer.focus", category: "composer", defaults: [] },
  { id: "composer.modelPicker", category: "composer", defaults: [] },

  // ── Session ──────────────────────────────────────────────────────────────
  { id: "session.new", category: "session", defaults: ["mod+n"] },
  // ⌃Tab / ⌃⇧Tab — the universal tab-cycle chord. Literally Control, not Cmd
  // (macOS reserves Cmd+Tab for app switching); see `ctrl` in combo.ts.
  { id: "session.next", category: "session", defaults: ["ctrl+tab"] },
  { id: "session.prev", category: "session", defaults: ["ctrl+shift+tab"] },
  { id: "session.focusSearch", category: "session", defaults: ["mod+shift+f"] },
  { id: "session.togglePin", category: "session", defaults: [] },

  // ── Navigation ───────────────────────────────────────────────────────────
  { id: "nav.commandPalette", category: "navigation", defaults: ["mod+k"] },
  { id: "nav.settings", category: "navigation", defaults: ["mod+,"] },

  // ── View (layout + appearance + the shortcuts panel itself) ───────────────
  { id: "view.toggleSidebar", category: "view", defaults: ["mod+b"] },
  { id: "view.toggleExplorer", category: "view", defaults: ["mod+j"] },
  { id: "appearance.toggleMode", category: "view", defaults: ["shift+x"] },
  { id: KEYBIND_PANEL_ACTION, category: "view", defaults: ["mod+/"] },
];

export const KEYBIND_ACTION_IDS: readonly string[] = KEYBIND_ACTIONS.map((action) => action.id);

const ACTION_BY_ID = new Map(KEYBIND_ACTIONS.map((action) => [action.id, action]));

export function keybindAction(id: string): KeybindActionMeta | undefined {
  return ACTION_BY_ID.get(id);
}

export type KeybindBindings = Record<string, string[]>;

export function defaultBindings(): KeybindBindings {
  return Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action.id, [...action.defaults]]));
}

// Fixed, non-rebindable shortcuts surfaced read-only in the panel so the map is
// complete. `keys` are canonical tokens run through `formatCombo` for display
// (single symbols like "@" / "/" pass through unchanged).
export interface KeybindReadonly {
  id: string;
  category: KeybindCategory;
  keys: readonly string[];
}

export const KEYBIND_READONLY: readonly KeybindReadonly[] = [
  { id: "composer.send", category: "composer", keys: ["enter"] },
  { id: "composer.newline", category: "composer", keys: ["shift+enter"] },
  { id: "composer.cancel", category: "composer", keys: ["escape"] },
  { id: "composer.mention", category: "composer", keys: ["@"] },
  { id: "composer.slash", category: "composer", keys: ["/"] },
];
