import { describe, expect, it } from "vitest";

import { shouldRestoreComposerFocus } from "./composer-focus";

describe("composer focus recovery", () => {
  it("restores a composer that lost focus only because the app window blurred", () => {
    expect(shouldRestoreComposerFocus({
      hadComposerFocus: true,
      disabled: false,
      documentHasFocus: true,
      shellIsInert: false,
    })).toBe(true);
  });

  it("never steals focus from a modal or disabled composer", () => {
    expect(shouldRestoreComposerFocus({
      hadComposerFocus: true,
      disabled: false,
      documentHasFocus: true,
      shellIsInert: true,
    })).toBe(false);
    expect(shouldRestoreComposerFocus({
      hadComposerFocus: true,
      disabled: true,
      documentHasFocus: true,
      shellIsInert: false,
    })).toBe(false);
  });
});
