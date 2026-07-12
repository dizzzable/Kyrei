import { describe, it, expect, beforeEach } from "vitest";

import { defaultBindings } from "@/lib/keybinds/actions";
import {
  actionForCombo,
  bindings,
  conflictsFor,
  getBinding,
  keybindOverrides,
  rebind,
  reset,
  resetAll,
} from "@/store/keybinds";

// The store is a module singleton, so isolate each test on a clean diff.
beforeEach(() => {
  resetAll();
});

describe("keybinds store", () => {
  describe("rebind — stores only the diff", () => {
    it("persists a non-default combo as an override", () => {
      rebind("nav.commandPalette", ["mod+p"]);

      expect(keybindOverrides.get()).toEqual({ "nav.commandPalette": ["mod+p"] });
      expect(getBinding("nav.commandPalette")).toEqual(["mod+p"]);
    });

    it("drops the override when the new combos equal the default", () => {
      rebind("nav.commandPalette", ["mod+p"]);
      rebind("nav.commandPalette", ["mod+k"]); // back to the shipped default

      expect(keybindOverrides.get()).toEqual({});
      expect(getBinding("nav.commandPalette")).toEqual(["mod+k"]);
    });

    it("ignores unknown action ids", () => {
      rebind("does.not.exist", ["mod+z"]);
      expect(keybindOverrides.get()).toEqual({});
    });
  });

  describe("reset — returns to the shipped default", () => {
    it("removes an override so the default applies again", () => {
      rebind("view.toggleSidebar", ["mod+shift+b"]);
      expect(getBinding("view.toggleSidebar")).toEqual(["mod+shift+b"]);

      reset("view.toggleSidebar");

      expect(keybindOverrides.get()).toEqual({});
      expect(getBinding("view.toggleSidebar")).toEqual(defaultBindings()["view.toggleSidebar"]);
      expect(getBinding("view.toggleSidebar")).toEqual(["mod+b"]);
    });

    it("resetAll clears every override", () => {
      rebind("nav.commandPalette", ["mod+p"]);
      rebind("view.toggleSidebar", ["mod+shift+b"]);

      resetAll();

      expect(keybindOverrides.get()).toEqual({});
      expect(bindings()).toEqual(defaultBindings());
    });
  });

  describe("reverse-lookup — combo → action", () => {
    it("resolves default combos to their action", () => {
      expect(actionForCombo("mod+k")).toBe("nav.commandPalette");
      expect(actionForCombo("mod+b")).toBe("view.toggleSidebar");
    });

    it("folds ctrl → mod when resolving off macOS", () => {
      // session.next ships as ctrl+tab, indexed canonically as mod+tab.
      expect(actionForCombo("ctrl+tab")).toBe("session.next");
      expect(actionForCombo("mod+tab")).toBe("session.next");
    });

    it("follows a rebind", () => {
      rebind("nav.commandPalette", ["mod+p"]);
      expect(actionForCombo("mod+p")).toBe("nav.commandPalette");
      expect(actionForCombo("mod+k")).toBeUndefined();
    });
  });

  describe("conflict detection", () => {
    it("detects an existing action already using the combo", () => {
      // mod+b is view.toggleSidebar's default; assigning it elsewhere clashes.
      expect(conflictsFor("session.togglePin", "mod+b")).toEqual(["view.toggleSidebar"]);
    });

    it("does not report the action itself as a conflict", () => {
      expect(conflictsFor("view.toggleSidebar", "mod+b")).toEqual([]);
    });

    it("reports no conflict for a free combo", () => {
      expect(conflictsFor("session.togglePin", "mod+shift+g")).toEqual([]);
    });
  });
});
