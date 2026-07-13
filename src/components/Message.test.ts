import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { Message } from "@/components/Message";
import { TooltipProvider } from "@/components/ui";
import { resetUiSettings, setUiSetting } from "@/store/settings";
import type { ChatMessage } from "@/lib/types";
import { I18nProvider, setLang } from "@/i18n";

const assistantMessage: ChatMessage = {
  id: "a-1",
  role: "assistant",
  parts: [
    { type: "reasoning", text: "step by step" },
    { type: "text", text: "final answer" },
  ],
};

describe("Message reasoning visibility", () => {
  beforeEach(() => {
    resetUiSettings();
    setLang("en");
  });

  it("shows reasoning blocks by default", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: assistantMessage }))),
    );

    expect(html).toContain("Thinking");
    expect(html).toContain("final answer");
  });

  it("hides reasoning blocks when the UI preference is disabled", () => {
    setUiSetting("showReasoning", false);

    const html = renderToStaticMarkup(
      createElement(I18nProvider, null,
        createElement(TooltipProvider, null, createElement(Message, { message: assistantMessage }))),
    );

    expect(html).not.toContain("Thinking");
    expect(html).toContain("final answer");
  });
});
