import { describe, expect, it } from "vitest";
import {
  extractFocusTerms,
  isLongHorizonGoal,
  skimTextForFocus,
  userAuthorizedBuild,
} from "./goal-skim.js";

describe("goal-skim", () => {
  it("extracts identifiers and paths as focus terms", () => {
    const terms = extractFocusTerms("Fix AuthService in src/auth/login.ts and handle OAuth tokens");
    expect(terms.some((t) => t.includes("authservice") || t.includes("auth"))).toBe(true);
    expect(terms.some((t) => t.includes("login") || t.includes("oauth"))).toBe(true);
  });

  it("detects long-horizon goals and short fixes", () => {
    expect(isLongHorizonGoal("typo in README")).toBe(false);
    expect(
      isLongHorizonGoal(
        "Refactor the authentication subsystem across multiple files: migrate from session cookies to JWT, update middleware, gateway, and UI login flow, then add tests end-to-end.",
      ),
    ).toBe(true);
  });

  it("skims large code toward focus matches", () => {
    const lines = Array.from({ length: 200 }, (_, i) => {
      if (i === 10) return "export function AuthService() {";
      if (i === 50) return "  validateToken();";
      if (i === 100) return "function unrelatedHelper() {}";
      return `// filler line ${i}`;
    });
    const big = lines.join("\n");
    const { text, skimmed, matchLines } = skimTextForFocus(big, {
      maxChars: 800,
      focus: "AuthService token",
    });
    expect(skimmed).toBe(true);
    expect(matchLines).toBeGreaterThan(0);
    expect(text).toContain("AuthService");
    expect(text.length).toBeLessThan(big.length);
  });

  it("recognizes build authorization phrases", () => {
    expect(userAuthorizedBuild("LGTM, implement the plan")).toBe(true);
    expect(userAuthorizedBuild("what do you think?")).toBe(false);
  });
});
