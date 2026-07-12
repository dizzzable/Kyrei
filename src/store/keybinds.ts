// Keybinds store: persists ONLY the diff from shipped defaults, so changing a
// default in a later release never gets shadowed by a stored snapshot.
//
// The persisted atom (`kyrei.keybinds.v1`) holds the override map alone; the
// effective bindings are `defaults ⊕ overrides`, computed on read. A reverse
// index (combo → actionId) drives dispatch, and `conflictsFor` surfaces clashes
// so the panel can flag them.

import { defaultBindings, KEYBIND_ACTION_IDS, keybindAction, type KeybindBindings } from "@/lib/keybinds/actions";
import { canonicalizeCombo } from "@/lib/keybinds/combo";
import { persistentJsonAtom } from "@/store/atom";

const STORAGE_KEY = "kyrei.keybinds.v1";

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Persisted overrides only — a sparse diff keyed by action id. */
export const keybindOverrides = persistentJsonAtom<KeybindBindings>(STORAGE_KEY, {});

// Effective bindings: shipped defaults overlaid with the user's stored diff.
// Unknown / stale action ids are dropped; actions added later pick up their
// shipped default automatically.
export function bindings(): KeybindBindings {
  const base = defaultBindings();
  const overrides = keybindOverrides.get();

  for (const id of KEYBIND_ACTION_IDS) {
    const value = overrides[id];

    if (Array.isArray(value)) {
      base[id] = value.filter((combo): combo is string => typeof combo === "string");
    }
  }

  return base;
}

/** Effective combos for a single action. */
export function getBinding(actionId: string): string[] {
  return bindings()[actionId] ?? [];
}

// Reverse lookup combo → actionId for dispatch. First action wins on conflict;
// the panel surfaces conflicts so users can resolve them. Keys go through
// `canonicalizeCombo` so a `ctrl+…` binding resolves everywhere.
export function comboIndex(): Map<string, string> {
  const current = bindings();
  const index = new Map<string, string>();

  for (const id of KEYBIND_ACTION_IDS) {
    for (const combo of current[id] ?? []) {
      const key = canonicalizeCombo(combo);

      if (!index.has(key)) {
        index.set(key, id);
      }
    }
  }

  return index;
}

/** Resolve a live/typed combo to the action it triggers, if any. */
export function actionForCombo(combo: string): string | undefined {
  return comboIndex().get(canonicalizeCombo(combo));
}

// Persist the new combos as a diff: drop the key when it equals the shipped
// default, otherwise store the override.
export function rebind(actionId: string, combos: string[]): void {
  const action = keybindAction(actionId);
  if (!action) return;

  const next = [...combos];
  const overrides = { ...keybindOverrides.get() };

  if (arraysEqual(next, action.defaults)) {
    delete overrides[actionId];
  } else {
    overrides[actionId] = next;
  }

  keybindOverrides.set(overrides);
}

/** Drop the override so the action falls back to its shipped default. */
export function reset(actionId: string): void {
  if (!keybindAction(actionId)) return;

  const overrides = { ...keybindOverrides.get() };
  delete overrides[actionId];
  keybindOverrides.set(overrides);
}

/** Clear every override — full return to shipped defaults. */
export function resetAll(): void {
  keybindOverrides.set({});
}

// Other actions that already use `combo` (excluding `actionId` itself). Compared
// canonically so `ctrl+…` and its folded `mod+…` form clash off macOS.
export function conflictsFor(actionId: string, combo: string): string[] {
  const current = bindings();
  const key = canonicalizeCombo(combo);

  return KEYBIND_ACTION_IDS.filter(
    (id) => id !== actionId && (current[id] ?? []).some((c) => canonicalizeCombo(c) === key),
  );
}
