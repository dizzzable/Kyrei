import { describe, expect, it } from "vitest";

import {
  redactSensitiveText,
  redactSensitiveValue,
} from "../core/secret-redaction.js";

describe("secret redaction", () => {
  it("redacts exact credentials between one and seven characters", () => {
    const redacted = redactSensitiveText(
      "x|ab|1234567|RED",
      ["x", "ab", "1234567", "RED"],
    );

    expect(redacted).toBe("[REDACTED]|[REDACTED]|[REDACTED]|[REDACTED]");
  });

  it("does not rescan replacement markers when a short secret overlaps REDACTED", () => {
    expect(redactSensitiveText("first=x second=RED", ["x", "RED"]))
      .toBe("first=[REDACTED] second=[REDACTED]");
  });

  it("applies short exact redaction recursively without changing unrelated metadata", () => {
    expect(redactSensitiveValue({
      message: "credential=q",
      metadata: { region: "eu", project: "kyrei" },
    }, ["q"])).toEqual({
      message: "credential=[REDACTED]",
      metadata: { region: "eu", project: "kyrei" },
    });
  });
});

describe("the two redactors stay in step", () => {
  // `core/secret-redaction.js` (gateway) and `core/engine/security/secrets.ts`
  // (engine) are separate implementations of the same policy, and they had
  // silently drifted in opposite directions — the gateway kept a loose `sk-`
  // pattern the engine had rejected, and lacked every format the engine gained.
  const samples = [
    "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd",
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "ghu_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "glpat-ABCDEFGHIJKLMNOPQRST",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz",
    "gsk_abcdefghijklmnopqrstuvwxyz0123456789abcdefgh",
    "xai-abcdefghijklmnopqrstuvwxyz0123456789abcdefgh",
    "hf_abcdefghijklmnopqrstuvwxyz0123456789",
    "postgres://admin:hunter2hunter2@db.example.test/app",
  ];

  for (const secret of samples) {
    it(`redacts ${JSON.stringify(secret.slice(0, 24))} on the gateway side too`, () => {
      const text = `value: ${secret} end`;
      expect(redactSensitiveText(text, [])).not.toContain(secret);
    });
  }

  it("does not redact ordinary hyphenated identifiers", () => {
    for (const innocent of [
      'class="sk-test-fading-circle-large"',
      "git checkout sk-proj-refactor-provider-build",
    ]) {
      expect(redactSensitiveText(innocent, [])).toBe(innocent);
    }
  });
});
