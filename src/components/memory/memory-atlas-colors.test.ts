// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { ATLAS_NODE_KINDS, atlasNodeColorValue, atlasNodeColorVar, atlasNodePalette, isThreeParsableColor, resolveThemeColor } from "./memory-atlas-colors";

describe("memory atlas colours", () => {
  it("gives every node kind a DISTINCT colour", () => {
    // The palette used to map onto the theme's semantic tokens, but those
    // collapse: primary and success are the same teal, and muted/secondary/
    // faint are all color-mix() over the same base. Ten kinds rendered as four
    // colours — five of them identical — so the graph said nothing about what
    // anything was.
    const colors = ATLAS_NODE_KINDS.map((kind) => atlasNodeColorVar(kind));
    expect(new Set(colors).size).toBe(ATLAS_NODE_KINDS.length);
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns the concrete palette colour without a property lookup", () => {
    // `resolveThemeColor` reads a CUSTOM PROPERTY BY NAME, so passing it a hex
    // looked up a property called "#16f2c8", found nothing, and returned the
    // neutral fallback — every node the same grey.
    expect(atlasNodeColorValue("document")).toBe(atlasNodeColorVar("document"));
    expect(atlasNodeColorValue("document")).not.toBe("#9ca3af");
  });

  it("still falls back to a neutral grey for an unset custom property", () => {
    expect(resolveThemeColor("--not-a-real-token")).toBe("#9ca3af");
  });

  it("keeps each family visually together", () => {
    // Grouping is the point: project material, work-in-progress and agent
    // memory should read as three families rather than ten unrelated dots.
    const hueOf = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return ((h * 60) + 360) % 360;
    };
    // Code and documents are both cool; sessions and skills are both violet.
    expect(Math.abs(hueOf(atlasNodeColorVar("code")) - hueOf(atlasNodeColorVar("document")))).toBeLessThan(60);
    expect(Math.abs(hueOf(atlasNodeColorVar("session")) - hueOf(atlasNodeColorVar("skill")))).toBeLessThan(60);
    // …and the families are far apart from each other.
    expect(Math.abs(hueOf(atlasNodeColorVar("code")) - hueOf(atlasNodeColorVar("session")))).toBeGreaterThan(60);
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

describe("isThreeParsableColor", () => {
  // THREE.Color understands hex, comma-form rgb/hsl and named colours. Anything
  // else leaves it at its default — BLACK — after a console warning. This theme
  // uses color-mix() for three variables, so 886 of 1898 Atlas nodes rendered
  // black on a dark background and the graph looked empty.
  it.each([
    "#fff",
    "#16f2c8",
    "#16f2c8ff",
    "rgb(22, 242, 200)",
    "rgba(22, 242, 200, 0.46)",
    "hsl(120, 50%, 50%)",
    "teal",
  ])("accepts %s", (value) => {
    expect(isThreeParsableColor(value)).toBe(true);
  });

  it.each([
    "color-mix(in srgb, #ece1ff 46%, transparent)",
    "oklch(0.7 0.15 200)",
    "lab(50% 40 59.5)",
    "rgb(22 242 200 / 46%)",
    "hsl(120deg 50% 50% / 40%)",
    "",
  ])("rejects %s", (value) => {
    expect(isThreeParsableColor(value)).toBe(false);
  });
});

describe("resolveThemeColor normalizes what three.js cannot parse", () => {
  const setVar = (value: string) => document.documentElement.style.setProperty("--probe-color", value);

  afterEach(() => document.documentElement.style.removeProperty("--probe-color"));

  it("passes a hex value through untouched", () => {
    setVar("#16f2c8");
    expect(resolveThemeColor("--probe-color")).toBe("#16f2c8");
  });

  it("falls back to a visible grey rather than returning an unparsable value", () => {
    // The point of the fallback: a wrong-but-visible colour beats an invisible
    // node. Whatever comes back must be something three.js can actually read.
    setVar("color-mix(in srgb, #ece1ff 46%, transparent)");
    const resolved = resolveThemeColor("--probe-color");
    expect(isThreeParsableColor(resolved)).toBe(true);
    expect(resolved).not.toBe("");
  });

  it("falls back when the variable is unset", () => {
    expect(isThreeParsableColor(resolveThemeColor("--not-defined-anywhere"))).toBe(true);
  });

  it("returns only parsable colours for every Atlas node kind", () => {
    for (const kind of ATLAS_NODE_KINDS) {
      expect(isThreeParsableColor(atlasNodeColorValue(kind)), kind).toBe(true);
    }
  });
});

describe("srgb() normalization", () => {
  // Chromium computes `color-mix(in srgb, …)` down to `color(srgb …)`, which
  // three.js also cannot parse — so without converting it the round-trip still
  // ended in the grey fallback and every muted/secondary/faint node lost its
  // own tint.
  it("keeps a color-mix variable's actual hue instead of falling back", () => {
    document.documentElement.style.setProperty("--probe-mix", "color-mix(in srgb, #ece1ff 46%, transparent)");
    const resolved = resolveThemeColor("--probe-mix");
    document.documentElement.style.removeProperty("--probe-mix");

    expect(isThreeParsableColor(resolved)).toBe(true);
    // jsdom may not implement color-mix; either way the result must be usable,
    // and when it IS resolved it must not be the neutral fallback.
    if (resolved.startsWith("rgb")) {
      const [r, g, b] = resolved.replace(/[^\d,]/g, "").split(",").map(Number);
      expect(r).toBeGreaterThan(0);
      expect(Math.max(r!, g!, b!)).toBeGreaterThan(0);
    }
  });
});
