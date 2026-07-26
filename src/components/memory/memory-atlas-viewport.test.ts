import { describe, expect, it } from "vitest";
import { FIT_MARGIN, MIN_FRAMEABLE_EXTENT, atlasCameraPlan, atlasFitDistance, fitViewport, panViewport, zoomViewportAt } from "./memory-atlas-viewport";

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

describe("atlasFitDistance", () => {
  /** What fraction of the viewport height a graph occupies at a given distance. */
  const fillAt = (distance: number, halfExtent: number, fovDeg: number) =>
    halfExtent / (distance * Math.tan((fovDeg * Math.PI) / 360));

  it("actually fills the viewport", () => {
    // The regression: the library's `zoomToFit` placed the camera 4 028 units
    // from a graph 1 976 across, so the finished layout filled 40% of the
    // width and sat marooned in the middle of the view.
    const distance = atlasFitDistance(1976 / 2, 50, 868 / 684);
    expect(fillAt(distance, 1976 / 2, 50)).toBeCloseTo(1 / FIT_MARGIN, 5);
    expect(distance).toBeLessThan(2600);
  });

  it("pulls back on a tall viewport so nothing is cropped sideways", () => {
    // When the window is narrower than it is tall, width is the binding
    // constraint and the camera has to retreat further, not less.
    expect(atlasFitDistance(1000, 50, 0.5)).toBeGreaterThan(atlasFitDistance(1000, 50, 1));
    expect(atlasFitDistance(1000, 50, 2)).toBe(atlasFitDistance(1000, 50, 1));
  });

  it("scales linearly with the graph and never returns a negative distance", () => {
    expect(atlasFitDistance(2000, 50, 1)).toBeCloseTo(atlasFitDistance(1000, 50, 1) * 2, 6);
    expect(atlasFitDistance(0, 50, 1)).toBe(0);
    expect(atlasFitDistance(-50, 50, 1)).toBe(0);
  });

  it("survives a degenerate camera or viewport instead of dividing by zero", () => {
    expect(Number.isFinite(atlasFitDistance(1000, 0, 0))).toBe(true);
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

  it("re-frames a graph that outgrew the framing it was given", () => {
    // The early fit runs on a timer, seconds before the simulation settles, so
    // it measures a layout that is still contracting. Latching on that left the
    // finished graph occupying a fraction of the viewport.
    expect(atlasCameraPlan({ nodeCount: 1791, fittedForCount: 1791, selectedInGraph: false, graphExtent: 2600, fittedExtent: 400 })).toBe("fit");
  });

  it("re-frames a graph that contracted onto its anchors", () => {
    // Measured live: the library seeds nodes over a sphere sized by node count
    // and the category anchors then pull the whole graph inward, so a
    // growth-only rule left a 2 000-unit graph framed from 3 800 away, filling
    // 43% of the width, with no later pass correcting it.
    expect(atlasCameraPlan({ nodeCount: 2494, fittedForCount: 2494, selectedInGraph: false, graphExtent: 1973, fittedExtent: 4200 })).toBe("fit");
  });

  it("ignores a graph that merely jiggled", () => {
    // Re-fitting on small drift would fight the user's own pan and zoom.
    expect(atlasCameraPlan({ nodeCount: 1791, fittedForCount: 1791, selectedInGraph: false, graphExtent: 2700, fittedExtent: 2600 })).toBe("skip");
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
