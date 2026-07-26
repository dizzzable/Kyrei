import { describe, expect, it } from "vitest";
import { MIN_FRAMEABLE_EXTENT, atlasCameraPlan, fitViewport, panViewport, zoomViewportAt } from "./memory-atlas-viewport";

describe("memory atlas viewport", () => {
  it("keeps the graph point under the cursor while zooming", () => {
    const initial = { scale: 1, x: 20, y: 30 };
    const next = zoomViewportAt(initial, 2, { x: 220, y: 130 });
    expect(next).toEqual({ scale: 2, x: -180, y: -70 });
  });

  it("clamps scale and pans in screen coordinates", () => {
    expect(zoomViewportAt({ scale: 1, x: 0, y: 0 }, 99, { x: 0, y: 0 }).scale).toBe(4);
    expect(panViewport({ scale: 2, x: 5, y: 7 }, 10, -3)).toEqual({ scale: 2, x: 15, y: 4 });
  });

  it("fits bounds into the viewport with padding", () => {
    expect(fitViewport({ width: 1000, height: 600 }, { x: 100, y: 100, width: 400, height: 200 }, 50)).toEqual({
      scale: 2.25,
      x: -175,
      y: -150,
    });
  });
});

describe("atlasCameraPlan", () => {
  // Regression: the 3D view never framed its camera. `focusNode` bails when the
  // node has no coordinates yet — exactly the case on first render — and
  // nothing called zoomToFit, so a large graph rendered as a black viewport
  // with a perfectly healthy scene just out of view.
  it("fits an unframed graph", () => {
    expect(atlasCameraPlan({ nodeCount: 1791, fittedForCount: -1, selectedInGraph: false, graphExtent: 2600 })).toBe("fit");
  });

  it("prefers the selection over an overview fit", () => {
    expect(atlasCameraPlan({ nodeCount: 1791, fittedForCount: -1, selectedInGraph: true, graphExtent: 2600 })).toBe("focus-selection");
  });

  it("does not re-frame a graph it already framed", () => {
    // Re-fitting would fight the user's own pan/zoom on every engine tick.
    expect(atlasCameraPlan({ nodeCount: 1791, fittedForCount: 1791, selectedInGraph: false, graphExtent: 2600 })).toBe("skip");
  });

  it("frames again when the node set changes", () => {
    expect(atlasCameraPlan({ nodeCount: 300, fittedForCount: 1791, selectedInGraph: false, graphExtent: 2600 })).toBe("fit");
  });

  it("does nothing for an empty graph", () => {
    expect(atlasCameraPlan({ nodeCount: 0, fittedForCount: -1, selectedInGraph: false, graphExtent: 2600 })).toBe("skip");
  });

  it("waits for the layout to spread before framing", () => {
    // The layout starts collapsed at the origin. Framing it then fits a POINT:
    // the camera lands metres from the centre and stays there while the graph
    // expands around it — which is exactly how the view went black.
    expect(atlasCameraPlan({ nodeCount: 1898, fittedForCount: -1, selectedInGraph: false, graphExtent: 0 })).toBe("skip");
    expect(atlasCameraPlan({ nodeCount: 1898, fittedForCount: -1, selectedInGraph: false, graphExtent: 5 })).toBe("skip");
    expect(atlasCameraPlan({ nodeCount: 1898, fittedForCount: -1, selectedInGraph: false, graphExtent: MIN_FRAMEABLE_EXTENT })).toBe("fit");
  });
});
