import { describe, it, expect } from "vitest";

import {
  canonicalizeCombo,
  comboFromEvent,
  comboTokens,
  formatCombo,
} from "@/lib/keybinds/combo";

// Node 22+ exposes `navigator`, so the detected platform follows the CI host.
// Pass the platform explicitly to keep both branches deterministic everywhere.
const NON_MAC = false;
const MAC = true;

describe("keybind combo", () => {

  describe("canonicalizeCombo — mod/ctrl normalization", () => {
    it("folds ctrl → mod off macOS", () => {
      expect(canonicalizeCombo("ctrl+tab", NON_MAC)).toBe("mod+tab");
      expect(canonicalizeCombo("ctrl+shift+tab", NON_MAC)).toBe("mod+shift+tab");
    });

    it("keeps physical Control distinct on macOS", () => {
      expect(canonicalizeCombo("ctrl+tab", MAC)).toBe("ctrl+tab");
    });

    it("leaves mod combos untouched", () => {
      expect(canonicalizeCombo("mod+k", NON_MAC)).toBe("mod+k");
      expect(canonicalizeCombo("mod+shift+f", NON_MAC)).toBe("mod+shift+f");
    });

    it("leaves bare/shift combos untouched", () => {
      expect(canonicalizeCombo("shift+x", NON_MAC)).toBe("shift+x");
      expect(canonicalizeCombo("enter", NON_MAC)).toBe("enter");
    });
  });

  describe("formatCombo", () => {
    it("joins modifier + base with '+' off macOS", () => {
      expect(formatCombo("mod+k", NON_MAC)).toBe("Ctrl+K");
      expect(formatCombo("mod+shift+f", NON_MAC)).toBe("Ctrl+Shift+F");
      expect(formatCombo("shift+x", NON_MAC)).toBe("Shift+X");
    });

    it("renders named base tokens via their labels", () => {
      expect(formatCombo("enter", NON_MAC)).toBe("↵");
      expect(formatCombo("ctrl+tab", NON_MAC)).toBe("Ctrl+⇥");
    });

    it("passes single-symbol bases through uppercased where relevant", () => {
      expect(formatCombo("mod+/", NON_MAC)).toBe("Ctrl+/");
      expect(formatCombo("mod+,", NON_MAC)).toBe("Ctrl+,");
    });

    it("uses compact macOS glyphs", () => {
      expect(formatCombo("mod+shift+k", MAC)).toBe("⌘⇧K");
      expect(formatCombo("ctrl+tab", MAC)).toBe("⌃⇥");
    });
  });

  describe("comboTokens", () => {
    it("returns one cap per token", () => {
      expect(comboTokens("mod+k", NON_MAC)).toEqual(["Ctrl", "K"]);
      expect(comboTokens("mod+shift+f", NON_MAC)).toEqual(["Ctrl", "Shift", "F"]);
      expect(comboTokens("mod+k", MAC)).toEqual(["⌘", "K"]);
    });
  });

  describe("comboFromEvent", () => {
    function evt(partial: Partial<KeyboardEvent>): KeyboardEvent {
      return {
        code: "",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...partial,
      } as KeyboardEvent;
    }

    it("returns null while only modifiers are held", () => {
      expect(comboFromEvent(evt({ code: "ControlLeft", ctrlKey: true }), NON_MAC)).toBeNull();
    });

    it("derives base from event.code, unaffected by Shift", () => {
      expect(comboFromEvent(evt({ code: "Slash", shiftKey: true }), NON_MAC)).toBe("shift+/");
    });

    it("maps Control to `mod` off macOS", () => {
      expect(comboFromEvent(evt({ code: "KeyK", ctrlKey: true }), NON_MAC)).toBe("mod+k");
    });

    it("maps physical Control to `ctrl` on macOS", () => {
      expect(comboFromEvent(evt({ code: "KeyK", ctrlKey: true }), MAC)).toBe("ctrl+k");
    });

    it("keeps Meta as `mod`", () => {
      expect(comboFromEvent(evt({ code: "KeyB", metaKey: true }), NON_MAC)).toBe("mod+b");
      expect(comboFromEvent(evt({ code: "KeyB", metaKey: true }), MAC)).toBe("mod+b");
    });
  });
});
