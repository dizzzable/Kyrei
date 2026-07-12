import { describe, it, expect } from "vitest";

import {
  IS_MAC,
  canonicalizeCombo,
  comboFromEvent,
  comboTokens,
  formatCombo,
} from "@/lib/keybinds/combo";

// Tests run under vitest's `node` environment, where `navigator` is undefined,
// so IS_MAC is false. That's the deterministic non-mac branch we assert against.
describe("keybind combo (non-mac test environment)", () => {
  it("runs on the non-mac branch", () => {
    expect(IS_MAC).toBe(false);
  });

  describe("canonicalizeCombo — mod/ctrl normalization", () => {
    it("folds ctrl → mod off macOS", () => {
      expect(canonicalizeCombo("ctrl+tab")).toBe("mod+tab");
      expect(canonicalizeCombo("ctrl+shift+tab")).toBe("mod+shift+tab");
    });

    it("leaves mod combos untouched", () => {
      expect(canonicalizeCombo("mod+k")).toBe("mod+k");
      expect(canonicalizeCombo("mod+shift+f")).toBe("mod+shift+f");
    });

    it("leaves bare/shift combos untouched", () => {
      expect(canonicalizeCombo("shift+x")).toBe("shift+x");
      expect(canonicalizeCombo("enter")).toBe("enter");
    });
  });

  describe("formatCombo", () => {
    it("joins modifier + base with '+' off macOS", () => {
      expect(formatCombo("mod+k")).toBe("Ctrl+K");
      expect(formatCombo("mod+shift+f")).toBe("Ctrl+Shift+F");
      expect(formatCombo("shift+x")).toBe("Shift+X");
    });

    it("renders named base tokens via their labels", () => {
      expect(formatCombo("enter")).toBe("↵");
      expect(formatCombo("ctrl+tab")).toBe("Ctrl+⇥");
    });

    it("passes single-symbol bases through uppercased where relevant", () => {
      expect(formatCombo("mod+/")).toBe("Ctrl+/");
      expect(formatCombo("mod+,")).toBe("Ctrl+,");
    });
  });

  describe("comboTokens", () => {
    it("returns one cap per token", () => {
      expect(comboTokens("mod+k")).toEqual(["Ctrl", "K"]);
      expect(comboTokens("mod+shift+f")).toEqual(["Ctrl", "Shift", "F"]);
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
      expect(comboFromEvent(evt({ code: "ControlLeft", ctrlKey: true }))).toBeNull();
    });

    it("derives base from event.code, unaffected by Shift", () => {
      expect(comboFromEvent(evt({ code: "Slash", shiftKey: true }))).toBe("shift+/");
    });

    it("maps Control to `mod` off macOS", () => {
      expect(comboFromEvent(evt({ code: "KeyK", ctrlKey: true }))).toBe("mod+k");
    });

    it("keeps Meta as `mod`", () => {
      expect(comboFromEvent(evt({ code: "KeyB", metaKey: true }))).toBe("mod+b");
    });
  });
});
