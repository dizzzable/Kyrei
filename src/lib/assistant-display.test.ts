import { describe, expect, it } from "vitest";

import { isInternalAssistantDisplayLine, sanitizeAssistantDisplayText } from "./assistant-display";

describe("assistant display sanitizer", () => {
  it("removes the hidden AUTO mode protocol marker", () => {
    expect(sanitizeAssistantDisplayText("MODE_SWITCH:build\n\nShip the fix.")).toBe("Ship the fix.");
  });

  it("removes standalone internal phase and verification lines", () => {
    expect(sanitizeAssistantDisplayText(
      "Effective phase: build — implement now.\n\nShip the fix.\n[goal-verify] gap remains\n\n[verify-before-done] run tests first.",
    )).toBe("Ship the fix.");
  });

  it("preserves ordinary content that mentions markers mid-paragraph", () => {
    const text = "Users may literally type Effective phase: build in a sentence.\nWe also document [goal-verify] as a token.";
    expect(sanitizeAssistantDisplayText(text)).toBe(text);
  });

  it("recognizes internal assistant marker lines", () => {
    expect(isInternalAssistantDisplayLine("MODE_SWITCH:deepreep")).toBe(true);
    expect(isInternalAssistantDisplayLine("Effective phase: polish — audit")).toBe(true);
    expect(isInternalAssistantDisplayLine("[goal-verify] goal not confirmed")).toBe(true);
    expect(isInternalAssistantDisplayLine("[verify-before-done] run tests")).toBe(true);
    expect(isInternalAssistantDisplayLine("Use [goal-verify] inside prose")).toBe(false);
  });
});
