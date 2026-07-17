import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { buildWorkingStatePin, isWorkingStatePinMessage, withWorkingStatePin } from "./working-state.js";

describe("working-state pin", () => {
  it("builds a pin that includes the goal", () => {
    const pin = buildWorkingStatePin(
      [{ role: "user", content: "Implement OAuth login across the gateway" }] as ModelMessage[],
    );
    expect(pin).toContain("Kyrei working state");
    expect(pin.toLowerCase()).toContain("oauth");
  });

  it("appends pin idempotently", () => {
    const messages = [
      { role: "user", content: "Build multi-file feature X with tests" },
      { role: "assistant", content: "Exploring..." },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Still working" },
    ] as ModelMessage[];
    const once = withWorkingStatePin(messages);
    const twice = withWorkingStatePin(once);
    expect(twice.filter(isWorkingStatePinMessage)).toHaveLength(1);
  });
});
