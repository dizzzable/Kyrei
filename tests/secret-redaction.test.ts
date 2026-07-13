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
