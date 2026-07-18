import { describe, expect, it, vi } from "vitest";

import { hasOpenEscapeLayer, shouldInterruptSessionFromEscape } from "@/lib/escape-hotkey";

describe("escape hotkey helpers", () => {
  it("detects an open radix dialog or popper layer", () => {
    const querySelector = vi.fn().mockReturnValue({});

    expect(hasOpenEscapeLayer({ querySelector })).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(
      '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper] [data-state="open"]',
    );
  });

  it("does not interrupt while another escape layer owns the key", () => {
    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape" },
      streaming: true,
      stopping: false,
      hasOpenLayer: true,
    })).toBe(false);
  });

  it("does not interrupt when a nested handler already consumed escape", () => {
    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape", defaultPrevented: true },
      streaming: true,
      stopping: false,
    })).toBe(false);
  });

  it("does not interrupt during IME composition", () => {
    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape", isComposing: true },
      streaming: true,
      stopping: false,
    })).toBe(false);

    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape", keyCode: 229 },
      streaming: true,
      stopping: false,
    })).toBe(false);
  });

  it("interrupts an active turn when escape is otherwise unclaimed", () => {
    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape" },
      streaming: true,
      stopping: false,
    })).toBe(true);
  });

  it("ignores escape when no turn is active or a stop is already pending", () => {
    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape" },
      streaming: false,
      stopping: false,
    })).toBe(false);

    expect(shouldInterruptSessionFromEscape({
      event: { key: "Escape" },
      streaming: true,
      stopping: true,
    })).toBe(false);
  });
});
