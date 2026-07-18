import { describe, expect, it } from "vitest";
import { cssColorToHex } from "./window-theme";

describe("cssColorToHex", () => {
  it("converts computed RGB colours into Electron overlay colours", () => {
    expect(cssColorToHex("rgb(23, 29, 38)")).toBe("#171d26");
    expect(cssColorToHex("rgba(223, 227, 240, 0.8)")).toBe("#dfe3f0");
  });

  it("rejects unsupported and out-of-range values", () => {
    expect(cssColorToHex("color-mix(in srgb, red, blue)")).toBeNull();
    expect(cssColorToHex("rgb(256, 0, 0)")).toBeNull();
  });
});
