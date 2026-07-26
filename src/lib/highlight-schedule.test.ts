import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_COALESCE_MS,
  HIGHLIGHT_MAX_WAIT_MS,
  HIGHLIGHT_NOW,
  HIGHLIGHT_SKIP,
  highlightDelayMs,
} from "./highlight-schedule";

describe("highlightDelayMs", () => {
  it("paints immediately the first time", () => {
    expect(highlightDelayMs({ previous: null, next: "const a = 1" })).toBe(HIGHLIGHT_NOW);
    // Including the degenerate empty block, which must not be mistaken for
    // "already rendered".
    expect(highlightDelayMs({ previous: null, next: "" })).toBe(HIGHLIGHT_NOW);
  });

  it("does nothing when the painted source is already current", () => {
    expect(highlightDelayMs({ previous: "same", next: "same" })).toBe(HIGHLIGHT_SKIP);
  });

  it("coalesces a pure append — the streaming case", () => {
    expect(highlightDelayMs({ previous: "const a =", next: "const a = 1" }))
      .toBe(HIGHLIGHT_COALESCE_MS);
    expect(highlightDelayMs({ previous: "", next: "c" })).toBe(HIGHLIGHT_COALESCE_MS);
  });

  it("paints immediately when the text is rewritten rather than appended", () => {
    // Re-mounting on stored history, an edit, or a shrink: the visible text has
    // already changed, so delaying would show wrong colours for the new source.
    expect(highlightDelayMs({ previous: "const a = 1", next: "let b = 2" })).toBe(HIGHLIGHT_NOW);
    expect(highlightDelayMs({ previous: "const a = 1", next: "const a" })).toBe(HIGHLIGHT_NOW);
  });

  it("paints immediately on a theme or language change, even with identical source", () => {
    // Without this the block would keep the old theme's colours forever, since
    // an unchanged source otherwise reports SKIP.
    expect(highlightDelayMs({ previous: "same", next: "same", styleChanged: true }))
      .toBe(HIGHLIGHT_NOW);
    expect(highlightDelayMs({ previous: "const a =", next: "const a = 1", styleChanged: true }))
      .toBe(HIGHLIGHT_NOW);
  });

  it("collapses a streamed block to a bounded number of runs", () => {
    // The property that motivates the whole module: with a trailing-edge timer,
    // appends between two ticks cost one run, not one run per token.
    const full = "function demo() {\n  return 42;\n}\n";
    let painted: string | null = null;
    let runs = 0;
    for (let i = 1; i <= full.length; i += 1) {
      const next = full.slice(0, i);
      const delay = highlightDelayMs({ previous: painted, next });
      if (delay === HIGHLIGHT_SKIP) continue;
      // Simulate the timer firing only every 8th token.
      if (delay === HIGHLIGHT_NOW || i % 8 === 0) {
        painted = next;
        runs += 1;
      }
    }
    // The pending trailing timer still fires once the stream stops, which is
    // what guarantees the block never settles on a stale prefix.
    if (highlightDelayMs({ previous: painted, next: full }) !== HIGHLIGHT_SKIP) {
      painted = full;
      runs += 1;
    }
    expect(runs).toBeLessThan(full.length / 4);
    expect(painted).toBe(full);
  });
});

describe("max-wait keeps a streaming block from freezing", () => {
  // A pure trailing-edge debounce never fires during a stream: tokens arrive
  // well inside the coalesce window, so each one cancels the pending run. The
  // block stayed at its FIRST paint — one character — until the stream ended.
  it("forces a repaint once the block has been stale too long", () => {
    expect(highlightDelayMs({
      previous: "const a =",
      next: "const a = 1",
      sinceLastPaintMs: HIGHLIGHT_MAX_WAIT_MS,
    })).toBe(HIGHLIGHT_NOW);
  });

  it("still coalesces while the last paint is recent", () => {
    expect(highlightDelayMs({
      previous: "const a =",
      next: "const a = 1",
      sinceLastPaintMs: HIGHLIGHT_MAX_WAIT_MS - 1,
    })).toBe(HIGHLIGHT_COALESCE_MS);
  });

  it("repaints at a bounded rate under a token stream that never pauses", () => {
    // Simulate the real component: a token every 20ms, and a timer that can
    // only fire if it survives the full coalesce window. Without max-wait the
    // painted source stays at its first character forever.
    const full = "function demo() {\n  return 42;\n}\n";
    let painted: string | null = null;
    let paintedAt = 0;
    let now = 0;
    let repaints = 0;
    for (let i = 1; i <= full.length; i += 1) {
      now += 20; // tokens arrive faster than HIGHLIGHT_COALESCE_MS
      const next = full.slice(0, i);
      const delay = highlightDelayMs({
        previous: painted,
        next,
        ...(painted === null ? {} : { sinceLastPaintMs: now - paintedAt }),
      });
      if (delay === HIGHLIGHT_NOW) {
        painted = next;
        paintedAt = now;
        repaints += 1;
      }
    }

    // It keeps up with the stream …
    expect(painted!.length).toBeGreaterThan(full.length / 2);
    // … without repainting on every token.
    expect(repaints).toBeLessThan(full.length / 4);
  });
});
