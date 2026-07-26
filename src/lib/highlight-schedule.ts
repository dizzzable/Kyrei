/**
 * Pacing for syntax highlighting of a code block that is still being streamed.
 *
 * Shiki's `codeToHtml` is synchronous main-thread work proportional to the
 * source length, and a streaming block re-runs it on every token — so a block
 * of length L costs O(L²) to render once. Coalescing pure appends collapses
 * that to a handful of runs without changing the final output.
 */

/** Long enough to swallow a burst of tokens, short enough to feel immediate. */
export const HIGHLIGHT_COALESCE_MS = 120;
/**
 * Ceiling on how long a block may sit un-repainted while tokens keep arriving.
 *
 * A pure trailing-edge debounce never fires during a stream: tokens arrive well
 * inside 120ms, so each one cancels the pending run. The block froze at its
 * first paint — one character — and only snapped to full when the stream
 * stopped. This bounds the staleness instead.
 */
export const HIGHLIGHT_MAX_WAIT_MS = 400;

/** Nothing to do: the source and theme are already the ones on screen. */
export const HIGHLIGHT_SKIP = -1;
/** Run now: first paint, a theme change, or a rewrite that is not an append. */
export const HIGHLIGHT_NOW = 0;

export interface HighlightRequest {
  /** Source last handed to the highlighter, or null before the first run. */
  previous: string | null;
  /** Source to render now. */
  next: string;
  /** True when the rendered output no longer matches the wanted theme/lang. */
  styleChanged?: boolean;
  /** Milliseconds since the last completed paint, if one has happened. */
  sinceLastPaintMs?: number;
}

/**
 * How long to wait before highlighting.
 *
 * Returns {@link HIGHLIGHT_SKIP} when the request is already satisfied,
 * {@link HIGHLIGHT_NOW} when the user would notice a delay, and
 * {@link HIGHLIGHT_COALESCE_MS} for a pure append — the streaming case, where
 * the block is about to grow again anyway.
 *
 * A caller MUST treat the delay as trailing-edge (last request wins), or the
 * block can settle on a stale prefix.
 */
export function highlightDelayMs({
  previous,
  next,
  styleChanged = false,
  sinceLastPaintMs,
}: HighlightRequest): number {
  // A theme or language switch has to repaint even if the source is identical.
  if (styleChanged) return HIGHLIGHT_NOW;
  if (previous === null) return HIGHLIGHT_NOW;
  if (previous === next) return HIGHLIGHT_SKIP;
  // Not an append: an edit, a re-mount on stored history, or a shrink. The
  // visible text already changed, so waiting would show wrong colours.
  if (!next.startsWith(previous)) return HIGHLIGHT_NOW;
  // A steady token stream re-arms the timer forever; force a repaint once the
  // block has been stale for long enough that the user would notice.
  if (sinceLastPaintMs !== undefined && sinceLastPaintMs >= HIGHLIGHT_MAX_WAIT_MS) return HIGHLIGHT_NOW;
  return HIGHLIGHT_COALESCE_MS;
}
