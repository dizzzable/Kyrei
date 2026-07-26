import type { MemoryAtlasNodeKind } from "@/lib/types";

/**
 * Shared node colour mapping for the memory Atlas, keyed by node kind. Used by
 * the 2D SVG canvas, the 3D force graph, and the minimap so the palette stays
 * consistent across every view. Values are CSS custom properties resolved
 * against the active theme.
 */
/**
 * Atlas node palette — deliberately NOT the theme's semantic tokens.
 *
 * Those collapse: `--color-primary` and `--color-success` are the same teal,
 * and `--color-muted`, `--color-secondary` and `--color-faint` are all
 * `color-mix()` over the same `#ece1ff`. Since three.js drops alpha, ten node
 * kinds rendered as four colours — five of them identical — and the graph
 * carried no information about what anything was.
 *
 * Hues are grouped by what a node BELONGS TO, so the graph reads by family at a
 * glance — cool blues for the project's own material, warm tones for the work
 * being done on it, violets for what the agent remembers — and stay distinct
 * within each family. Lightness is kept close so no kind disappears against the
 * dark canvas.
 */
const ATLAS_NODE_COLORS: Record<MemoryAtlasNodeKind, string> = {
  // The root of the workspace: brightest, exactly one per graph.
  project: "#f5f3ff",

  // ── What the project IS — cool blues. ──────────────────────────────────
  code: "#16f2c8", // teal, and the largest population
  document: "#4ea8ff", // blue

  // ── How the work PROCEEDS — warm. ─────────────────────────────────────
  decision: "#7ee787", // green: a settled call
  plan: "#ffd166", // amber: intent, not yet done
  handoff: "#ff8a5b", // coral: work passed on

  // ── What the AGENT remembers — violets. ───────────────────────────────
  session: "#b98cff", // light violet
  memory: "#e879f9", // magenta
  skill: "#7c6cf5", // indigo
  evolution: "#9aa8bd", // steel: proposals about the agent itself
};

export function atlasNodeColorVar(kind: MemoryAtlasNodeKind): string {
  return ATLAS_NODE_COLORS[kind] ?? FALLBACK_COLOR;
}

/**
 * Edge palette. Structural and semantic links used to be near-identical greys,
 * so the graph showed connections without showing what KIND of connection.
 */
export const ATLAS_EDGE_COLORS = {
  contains: "rgba(154, 168, 189, 0.35)", // structure: present but quiet
  imports: "rgba(22, 242, 200, 0.45)", // code → code, matches the code hue
  references: "rgba(199, 146, 234, 0.5)", // a document pointing at something
  related: "rgba(255, 93, 158, 0.45)", // semantic similarity
} as const;

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
/**
 * Colour syntaxes `THREE.Color` can parse.
 *
 * It understands hex, the COMMA form of `rgb()`/`rgba()`, `hsl()`/`hsla()` and
 * CSS named colours — and nothing else. Given anything newer it logs a warning
 * and leaves the colour at its default, which is BLACK. That is not a
 * hypothetical: this theme defines `--color-muted`, `--color-secondary` and
 * `--color-faint` as `color-mix(in srgb, …)`, so 886 of 1898 Atlas nodes
 * rendered pure black on a dark background.
 */
export function isThreeParsableColor(value: string): boolean {
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return true;
  // Comma form only: `rgb(255 0 0 / 50%)` is modern syntax three.js rejects.
  if (/^rgba?\(\s*[\d.]+\s*,/i.test(v)) return true;
  if (/^hsla?\(\s*[\d.]+\s*,/i.test(v)) return true;
  return /^[a-z]+$/i.test(v); // a CSS named colour
}

/**
 * Normalize any CSS colour to something three.js accepts, by letting the
 * browser compute it: assigning to `style.color` and reading it back always
 * yields `rgb()`/`rgba()` in comma form, whatever went in — `color-mix()`,
 * `oklch()`, `lab()`, a relative colour.
 */
function toParsableColor(value: string): string | undefined {
  if (isThreeParsableColor(value)) return value;
  if (typeof document === "undefined" || !document.body) return undefined;
  const probe = document.createElement("span");
  probe.style.color = value;
  // An invalid value leaves the property empty; do not render a guess.
  if (!probe.style.color) return undefined;
  probe.style.display = "none";
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  if (!computed) return undefined;
  if (isThreeParsableColor(computed)) return computed;
  return srgbFunctionToRgb(computed);
}

/**
 * Convert `color(srgb r g b [/ a])` — what Chromium computes a `color-mix()`
 * down to — into the comma-form `rgb()` three.js understands. Without this the
 * round-trip above still ends in the grey fallback, so every muted, secondary
 * and faint node renders the same neutral instead of its own tint.
 */
function srgbFunctionToRgb(value: string): string | undefined {
  const match = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(value.trim());
  if (!match) return undefined;
  const channel = (raw: string | undefined): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(255, Math.round(n * 255)));
  };
  return `rgb(${channel(match[1])}, ${channel(match[2])}, ${channel(match[3])})`;
}

export function resolveThemeColor(variable: string, root?: Element | null): string {
  const name = variable.replace(/^var\((--[^)]+)\)$/, "$1");
  if (typeof window !== "undefined") {
    const target = root ?? document.documentElement;
    const resolved = getComputedStyle(target).getPropertyValue(name).trim();
    if (resolved) return toParsableColor(resolved) ?? FALLBACK_COLOR;
  }
  return FALLBACK_COLOR;
}

/**
 * Resolve an Atlas node colour to a concrete string.
 *
 * The palette is already concrete, so this must NOT round-trip through
 * `resolveThemeColor`: that reads a CUSTOM PROPERTY by name, so handing it
 * `#16f2c8` looked up a property called "#16f2c8", found nothing, and returned
 * the neutral fallback — every node the same grey.
 */
export function atlasNodeColorValue(kind: MemoryAtlasNodeKind, root?: Element | null): string {
  const value = atlasNodeColorVar(kind);
  return value.startsWith("var(") ? resolveThemeColor(value, root) : value;
}

/** Resolve the whole node palette at once — one computed-style read per kind. */
export function atlasNodePalette(root?: Element | null): Record<MemoryAtlasNodeKind, string> {
  const palette = {} as Record<MemoryAtlasNodeKind, string>;
  for (const kind of ATLAS_NODE_KINDS) palette[kind] = atlasNodeColorValue(kind, root);
  return palette;
}
