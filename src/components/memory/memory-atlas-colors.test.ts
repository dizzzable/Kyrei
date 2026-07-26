import { describe, expect, it } from "vitest";

import { ATLAS_NODE_KINDS, atlasNodeColorValue, atlasNodeColorVar, atlasNodePalette, resolveThemeColor } from "./memory-atlas-colors";

describe("memory atlas colours", () => {
  it("maps every node kind to a CSS custom property", () => {
    for (const kind of ATLAS_NODE_KINDS) {
      expect(atlasNodeColorVar(kind)).toMatch(/^var\(--color-[a-z-]+\)$/);
    }
  });

  it("falls back to a neutral grey when no DOM is available", () => {
    // The suite runs in the node environment, so there is no computed style to
    // read — the WebGL renderer must still get a usable colour rather than "".
    expect(resolveThemeColor("--color-primary")).toBe("#9ca3af");
    expect(atlasNodeColorValue("document")).toBe("#9ca3af");
  });

  it("accepts a bare property name or a var() wrapper", () => {
    expect(resolveThemeColor("--color-secondary")).toBe(resolveThemeColor("var(--color-secondary)"));
  });

  it("resolves a palette entry for every kind", () => {
    const palette = atlasNodePalette();
    expect(Object.keys(palette).sort()).toEqual([...ATLAS_NODE_KINDS].sort());
    expect(Object.values(palette).every((value) => value.length > 0)).toBe(true);
  });
});
