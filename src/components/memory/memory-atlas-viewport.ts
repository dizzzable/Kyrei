export interface AtlasViewport {
  scale: number;
  x: number;
  y: number;
}

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Bounds extends Point, Size {}

export const ATLAS_MIN_SCALE = 0.25;
export const ATLAS_MAX_SCALE = 4;

export function normalizeViewport(value: Partial<AtlasViewport> | null | undefined): AtlasViewport {
  const scale = Number.isFinite(value?.scale) ? Math.min(ATLAS_MAX_SCALE, Math.max(ATLAS_MIN_SCALE, value!.scale!)) : 1;
  const x = Number.isFinite(value?.x) ? value!.x! : 0;
  const y = Number.isFinite(value?.y) ? value!.y! : 0;
  return { scale, x, y };
}

export function zoomViewportAt(viewport: AtlasViewport, requestedScale: number, cursor: Point): AtlasViewport {
  const scale = Math.min(ATLAS_MAX_SCALE, Math.max(ATLAS_MIN_SCALE, requestedScale));
  const ratio = scale / viewport.scale;
  return {
    scale,
    x: cursor.x - (cursor.x - viewport.x) * ratio,
    y: cursor.y - (cursor.y - viewport.y) * ratio,
  };
}

export function panViewport(viewport: AtlasViewport, dx: number, dy: number): AtlasViewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

export function fitViewport(container: Size, bounds: Bounds, padding = 40): AtlasViewport {
  const availableWidth = Math.max(1, container.width - padding * 2);
  const availableHeight = Math.max(1, container.height - padding * 2);
  const scale = Math.min(ATLAS_MAX_SCALE, Math.max(ATLAS_MIN_SCALE, Math.min(
    availableWidth / Math.max(1, bounds.width),
    availableHeight / Math.max(1, bounds.height),
  )));
  return {
    scale,
    x: (container.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (container.height - bounds.height * scale) / 2 - bounds.y * scale,
  };
}

/**
 * What the 3D camera should do once a graph settles.
 *
 * Extracted so the decision is testable: the 3D canvas cannot be rendered in
 * this suite (WebGL), and the bug it fixes was precisely that NOTHING framed
 * the camera — a large Atlas laid out across thousands of units while the
 * camera sat at its default distance, showing an empty viewport.
 */
export type AtlasCameraAction = "skip" | "fit" | "focus-selection";

export function atlasCameraPlan(input: {
  nodeCount: number;
  /** Node count the camera was last framed for; -1 when never framed. */
  fittedForCount: number;
  /** Selected node id, if it exists in the current graph. */
  selectedInGraph: boolean;
  /** Largest extent of the laid-out graph, in world units. */
  graphExtent: number;
  /** Extent the camera was last framed against; 0 when never framed. */
  fittedExtent?: number;
}): AtlasCameraAction {
  if (input.nodeCount === 0) return "skip";
  // The layout starts collapsed at the origin and expands over many ticks.
  // Framing it then fits a point — the camera lands metres from the origin and
  // stays there while the graph grows around it — and latching would make that
  // permanent. Wait until there is something with size to frame.
  if (input.graphExtent < MIN_FRAMEABLE_EXTENT) return "skip";
  if (input.fittedForCount === input.nodeCount) {
    // Framed for this node set already — but the early fit runs on a timer,
    // seconds before the simulation settles, and the layout is still moving.
    // Latching on that one measurement left the finished graph filling a
    // fraction of the viewport.
    //
    // The band is symmetric ON PURPOSE. A graph both expands and contracts:
    // the library seeds nodes over a sphere sized by node count, and category
    // anchors then pull the whole thing inward, so measuring only growth left
    // a 2 000-unit graph framed from 3 800 units away — filling 43% of the
    // width — and no later pass ever corrected it. Small drift is ignored so
    // this never fights a graph that has merely jiggled.
    const fitted = input.fittedExtent ?? 0;
    const grew = fitted > 0 && input.graphExtent > fitted * REFIT_GROWTH_FACTOR;
    const shrank = fitted > 0 && input.graphExtent * REFIT_GROWTH_FACTOR < fitted;
    if (grew || shrank) return input.selectedInGraph ? "focus-selection" : "fit";
    return "skip";
  }
  // A selection is the more specific intent than an overview fit.
  return input.selectedInGraph ? "focus-selection" : "fit";
}

/** Below this the layout has not spread yet and is not worth framing. */
export const MIN_FRAMEABLE_EXTENT = 20;

/** How far a graph must diverge from its framing, either way, before re-fitting. */
export const REFIT_GROWTH_FACTOR = 1.4;

/** Breathing room left around a framed graph, as a multiple of its half-extent. */
export const FIT_MARGIN = 1.12;

/**
 * Camera distance that fits a graph of the given size into the viewport.
 *
 * The library's own `zoomToFit` is not used for this: measured live, it placed
 * the camera 4 028 units from a graph 1 976 units across, filling 40% of the
 * width. Its distance formula applies `Math.atan` to the field of view where
 * the projection needs `Math.tan` of HALF of it, which overshoots by roughly a
 * factor of two — so the finished layout always sat in the middle of an
 * otherwise empty viewport.
 *
 * `halfExtent` is half the largest side of the bounding box, `fovDeg` the
 * camera's vertical field of view, `aspect` width ÷ height. The narrower of
 * the two axes decides, so nothing is cropped horizontally on a wide window.
 */
export function atlasFitDistance(halfExtent: number, fovDeg: number, aspect: number, margin = FIT_MARGIN): number {
  const vertical = Math.tan((Math.max(1, fovDeg) * Math.PI) / 360);
  const horizontal = vertical * Math.max(0.01, aspect);
  return (Math.max(0, halfExtent) * margin) / Math.min(vertical, horizontal);
}
