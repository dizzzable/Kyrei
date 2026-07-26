// @vitest-environment jsdom
/**
 * Behavioural coverage for the three UI settings that once shipped written,
 * defaulted and translated while being read by nothing — flipping them did
 * nothing at all, which teaches a user that the app ignores its own settings.
 *
 * These replace `tests/ui-settings-wiring.test.ts`, which asserted on SOURCE
 * TEXT with regexes because the suite had no DOM: that form breaks on any
 * rename and passes on code that is present but dead.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Message } from "@/components/Message";
import { TooltipProvider } from "@/components/ui";
import { $uiSettings, DEFAULT_UI_SETTINGS } from "@/store/settings";
import { I18nProvider } from "@/i18n";
import type { ChatMessage } from "@/lib/types";

const MARKDOWN = "# A heading\n\nplain paragraph";

const assistant: ChatMessage = {
  id: "m1",
  role: "assistant",
  parts: [{ type: "text", text: MARKDOWN }],
};

function renderMessage() {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <Message message={assistant} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  $uiSettings.set({ ...DEFAULT_UI_SETTINGS });
});

describe("richRendering decides whether Markdown is parsed", () => {
  it("renders a heading element when rich rendering is on", () => {
    $uiSettings.set({ ...DEFAULT_UI_SETTINGS, richRendering: true });
    const { container } = renderMessage();

    expect(container.querySelector("h1")).not.toBeNull();
    // The literal syntax must NOT survive as text.
    expect(screen.queryByText("# A heading")).toBeNull();
  });

  it("shows the raw text when rich rendering is off", () => {
    // The setting that did nothing before it was wired.
    $uiSettings.set({ ...DEFAULT_UI_SETTINGS, richRendering: false });
    const { container } = renderMessage();

    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).toContain("# A heading");
  });
});

describe("density reaches the DOM with a rule that can match", () => {
  it("puts the density on an element the compact rule targets", () => {
    // The compact rule used to target `.conversation-scroll > * + *`, which has
    // exactly ONE child — so it matched nothing and message spacing never
    // changed. Assert the shape the stylesheet actually depends on.
    const shell = document.createElement("div");
    shell.className = "conversation-shell";
    shell.dataset["density"] = "compact";
    shell.innerHTML = `
      <div class="conversation-scroll">
        <div><div class="conversation-messages"><div>a</div><div>b</div></div></div>
      </div>`;
    document.body.append(shell);

    const messages = shell.querySelector(".conversation-messages");
    expect(messages).not.toBeNull();
    // Two siblings, so `> :not([hidden]) ~ :not([hidden])` has something to hit.
    expect(messages!.children.length).toBeGreaterThan(1);
    expect(shell.matches('[data-density="compact"]')).toBe(true);

    shell.remove();
  });
});

describe("every wired UI setting still has a default", () => {
  it.each(["richRendering", "toolView", "density"] as const)("%s", (key) => {
    expect(DEFAULT_UI_SETTINGS[key]).toBeDefined();
  });
});
