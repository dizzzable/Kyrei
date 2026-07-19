import { describe, expect, it } from "vitest";
import {
  extractFocusTerms,
  isLongHorizonGoal,
  lastUserTextFromMessages,
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
    expect(userAuthorizedBuild("go ahead")).toBe(true);
    expect(userAuthorizedBuild("what do you think?")).toBe(false);
    // Bare implement is a task request, not plan release.
    expect(
      userAuthorizedBuild(
        "Implement OAuth across gateway, UI, and session store with tests end-to-end",
      ),
    ).toBe(false);
    expect(userAuthorizedBuild("реализуй авторизацию во всём проекте")).toBe(false);
  });

  it("skips synthetic recovery and pin prompts when resolving the last user text", () => {
    const messages = [
      { role: "user", content: "real user goal" },
      { role: "assistant", content: "ack" },
      {
        role: "user",
        content:
          "[Kyrei engine recovery checkpoint 7; not a new user request and not user-visible.] Continue the original task autonomously.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "[Kyrei working state — re-pinned]" },
          { type: "text", text: "Goal: real user goal" },
          { type: "text", text: "Constraints: stay in workspace" },
        ],
      },
    ] as const;

    expect(lastUserTextFromMessages(messages)).toBe("real user goal");
  });

  it("skips synthetic prompts even when the content arrives as text parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Project update" },
          { type: "text", text: "..." },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "[Kyrei engine recovery checkpoint 3; not a new user request and not user-visible.]" },
          { type: "text", text: "Continue the original task autonomously." },
        ],
      },
    ] as const;

    expect(lastUserTextFromMessages(messages)).toBe("Project update\n...");
  });

  it("skips the compressed summary message even when it is the last user turn", () => {
    const messages = [
      { role: "user", content: "real user goal" },
      {
        role: "user",
        content: [
          { type: "text", text: "## Context summary (reference only)" },
          { type: "text", text: "_This is historical context for the model._" },
          { type: "text", text: "### Task snapshot" },
          { type: "text", text: "- older work" },
          { type: "text", text: "--- END OF CONTEXT SUMMARY ---" },
        ],
      },
    ] as const;

    expect(lastUserTextFromMessages(messages)).toBe("real user goal");
  });
});
