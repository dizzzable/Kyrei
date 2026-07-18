import { describe, expect, it } from "vitest";
import { fitViewport, panViewport, zoomViewportAt } from "./memory-atlas-viewport";

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
