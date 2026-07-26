import type { MemoryAtlasNodeKind } from "@/lib/types";

/**
 * Shared node colour mapping for the memory Atlas, keyed by node kind. Used by
 * the 2D SVG canvas, the 3D force graph, and the minimap so the palette stays
 * consistent across every view. Values are CSS custom properties resolved
 * against the active theme.
 */
export function atlasNodeColorVar(kind: MemoryAtlasNodeKind): string {
  switch (kind) {
    case "project": return "var(--color-foreground)";
    case "code": return "var(--color-muted)";
    case "document": return "var(--color-primary)";
    case "decision": return "var(--color-success)";
    case "plan": return "var(--color-warning)";
    case "handoff": return "var(--color-danger)";
    case "skill": return "var(--color-primary)";
    case "session": return "var(--color-secondary)";
    case "evolution": return "var(--color-faint)";
    case "memory": return "var(--color-faint)";
    default: return "var(--color-faint)";
  }
}

/** Every node kind, so a renderer can resolve the whole palette in one pass. */
export const ATLAS_NODE_KINDS: readonly MemoryAtlasNodeKind[] = [
  "project", "code", "document", "decision", "plan", "handoff", "session", "memory", "skill", "evolution",
];

/** Neutral grey used when a variable is unset or cannot be resolved. */
const FALLBACK_COLOR = "#9ca3af";

/**
 * Resolve a CSS custom property to a concrete colour string for canvas/WebGL
 * renderers, which cannot read CSS variables. Accepts either `--color-x` or
 * `var(--color-x)`. Falls back to a neutral grey when the variable is unset or
 * resolution is unavailable (e.g. SSR/tests).
 *
 * This reads computed style, so callers should resolve once per theme rather
 * than per node per frame.
 */
export function resolveThemeColor(variable: string, root?: Element | null): string {
  const name = variable.replace(/^var\((--[^)]+)\)$/, "$1");
  if (typeof window !== "undefined") {
    const target = root ?? document.documentElement;
    const resolved = getComputedStyle(target).getPropertyValue(name).trim();
    if (resolved) return resolved;
  }
  return FALLBACK_COLOR;
}

/** Resolve an Atlas node colour to a concrete rgb string. */
export function atlasNodeColorValue(kind: MemoryAtlasNodeKind, root?: Element | null): string {
  return resolveThemeColor(atlasNodeColorVar(kind), root);
}

/** Resolve the whole node palette at once — one computed-style read per kind. */
export function atlasNodePalette(root?: Element | null): Record<MemoryAtlasNodeKind, string> {
  const palette = {} as Record<MemoryAtlasNodeKind, string>;
  for (const kind of ATLAS_NODE_KINDS) palette[kind] = atlasNodeColorValue(kind, root);
  return palette;
}
