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
}): AtlasCameraAction {
  if (input.nodeCount === 0) return "skip";
  // The layout starts collapsed at the origin and expands over many ticks.
  // Framing it then fits a point — the camera lands metres from the origin and
  // stays there while the graph grows around it — and latching would make that
  // permanent. Wait until there is something with size to frame.
  if (input.graphExtent < MIN_FRAMEABLE_EXTENT) return "skip";
  // Already framed for this exact node set; re-fitting would fight the user's
  // own camera after they have panned or zoomed.
  if (input.fittedForCount === input.nodeCount) return "skip";
  // A selection is the more specific intent than an overview fit.
  return input.selectedInGraph ? "focus-selection" : "fit";
}

/** Below this the layout has not spread yet and is not worth framing. */
export const MIN_FRAMEABLE_EXTENT = 20;
