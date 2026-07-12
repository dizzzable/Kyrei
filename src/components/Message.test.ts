import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { Message } from "@/components/Message";
import { resetUiSettings, setUiSetting } from "@/store/settings";
import type { ChatMessage } from "@/lib/types";

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
  });

  it("shows reasoning blocks by default", () => {
    const html = renderToStaticMarkup(createElement(Message, { message: assistantMessage }));

    expect(html).toContain("Размышление");
    expect(html).toContain("final answer");
  });

  it("hides reasoning blocks when the UI preference is disabled", () => {
    setUiSetting("showReasoning", false);

    const html = renderToStaticMarkup(createElement(Message, { message: assistantMessage }));

    expect(html).not.toContain("Размышление");
    expect(html).toContain("final answer");
  });
});
