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
