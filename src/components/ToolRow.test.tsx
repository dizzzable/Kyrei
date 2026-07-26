// @vitest-environment jsdom
/**
 * Real DOM coverage for the UI settings that were once written, defaulted and
 * translated while being read by nothing. `tests/ui-settings-wiring.test.ts`
 * asserted on SOURCE TEXT because the suite had no DOM: those regexes break on
 * a rename and pass on dead code. These render the component instead.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToolRow } from "@/components/ToolRow";
import { $uiSettings, DEFAULT_UI_SETTINGS } from "@/store/settings";
import type { ToolPart } from "@/lib/types";

const part: ToolPart = {
  type: "tool",
  toolCallId: "call-1",
  name: "read_file",
  args: { path: "src/a.ts" },
  result: "file body",
  running: false,
};

afterEach(() => {
  cleanup();
  $uiSettings.set({ ...DEFAULT_UI_SETTINGS });
});

describe("toolView actually changes what the tool row shows", () => {
  it("starts collapsed on the compact view", () => {
    $uiSettings.set({ ...DEFAULT_UI_SETTINGS, toolView: "compact" });
    render(<ToolRow part={part} />);

    expect(screen.queryByText(/file body/)).toBeNull();
  });

  it("starts expanded on the technical view", () => {
    // This is the setting that did nothing at all before it was wired.
    $uiSettings.set({ ...DEFAULT_UI_SETTINGS, toolView: "technical" });
    render(<ToolRow part={part} />);

    expect(screen.queryByText(/file body/)).not.toBeNull();
  });
});
